/**
 * FEATURE CRAWL — every menu entry, as every persona, judged.
 *
 * `bun run test:crawl [--persona root,admin,editor] [--only <tipo,…>] [--max <n>]
 *                     [--concurrency <n>] [--journey <a,b>] [--no-journeys]
 *                     [--out <dir>] [--port <n>] [--headful] [--strict]`
 *
 * Starts its OWN server on the SUITE database (the verified door of
 * test:client), installs the crawl personas (test/helpers/crawl_persona_fixture.ts)
 * and walks, per persona, everything that persona's menu offers
 * (getMenuTreeDatalist — the server's own answer):
 *
 *   - each section in list mode, then its first visible record in edit mode;
 *   - components: one representative instance per model must render, without
 *     an error panel, at the permission level the server grants
 *     (getPermissions) — a level-1 component exposes no enabled input;
 *   - inspector: every collapsed block is opened as a user does; a block that
 *     renders `.inspector_block_failure` is red;
 *   - tools: every offered tool must be one getUserTools grants, and opens
 *     without an error;
 *   - every page: no uncaught error, no `ok:false` API answer, no error panel;
 *   - then the persona's USER JOURNEYS (test/helpers/journey_cases.ts): real
 *     typing/clicking, each checked on the server (`--journey a,b` narrows,
 *     `--no-journeys` skips).
 *
 * Non-root personas also get the permission ORACLE: a section they hold no
 * grant on, a record outside their projects and an ungranted tool, each opened
 * by direct URL, must be refused — never served, never a crash.
 *
 * Verdict: findings minus KNOWN_FAILING and INTERMITTENT (test/helpers/feature_crawl_ratchet.ts,
 * shrink-only). `--out` writes crawl_report.json + one PNG per finding.
 * Needs `bun run test:db:setup` once. ONE suite run at a time: `bun test` and
 * test:client reseed test3 wholesale and would wipe the crawl's fixture records.
 *
 * AUDIT MODE — a READ-ONLY report on a staging copy of a real installation:
 *
 *   bun run test:crawl --audit --i-know-this-is-staging --url <origin>
 *                      --entity <name> --as <user>[,<user>…] [--out <dir>]
 *
 * Run ON the staging host, from its checkout (the process reads that install's
 * own ../private/.env: its database and session store). No fixture, no server,
 * no journeys, no ratchet. Sessions for the named EXISTING users are minted
 * in-process and destroyed at the end. Guards: the explicit flag; `/health`
 * at --url must name --entity; and every API request whose action is not a
 * read is ABORTED in the browser (listed in the report), so the crawl cannot
 * write whatever a page tries. Window-opening tools are not opened (their
 * first requests would race the guard). The oracle opens one section the user
 * holds no grant on.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type BrowserContext, type Page } from 'puppeteer';
import { readEnv } from '../src/config/env.ts';
import { INTERMITTENT, KNOWN_FAILING } from '../test/helpers/feature_crawl_ratchet.ts';
import { JOURNEYS, type JourneyContext, type PersonaName } from '../test/helpers/journey_cases.ts';
import {
	findFreePort,
	localSuiteFingerprint,
	repointProcessToSuiteDatabase,
	resolveSuiteDatabase,
	startClientTestServer,
	suiteServerPaths,
} from './client_test_server.ts';

const args = Bun.argv.slice(2);
const flag = (name: string): string | undefined => {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
};
const list = (name: string): string[] | undefined => flag(name)?.split(',').filter(Boolean);
const outDir = flag('--out');
const onlyTipos = list('--only');
const maxSections = Number.parseInt(flag('--max') ?? '0', 10);
const strict = args.includes('--strict');
const concurrency = Number.parseInt(flag('--concurrency') ?? '4', 10);
const audit = args.includes('--audit');
const auditUrl = flag('--url');
const auditEntity = flag('--entity');
const auditUsers = list('--as') ?? [];
if (
	audit &&
	(!args.includes('--i-know-this-is-staging') ||
		!auditUrl ||
		!auditEntity ||
		auditUsers.length === 0)
) {
	console.error(
		'--audit needs --i-know-this-is-staging, --url <origin>, --entity <name> and --as <user,…>',
	);
	process.exit(2);
}
const PAGE_TIMEOUT = 60_000;

interface Finding {
	id: string;
	detail: string;
}
interface PageSignals {
	problems: string[];
	notes: string[];
	apiErrors: { url: string; code: string }[];
}

// the repoint must precede the first dynamic import that connects; the run's own
// session store, so a session minted here is one the spawned server reads
// (audit: no repoint — the staging install's own database and session store)
const suiteDb = audit ? '' : resolveSuiteDatabase().suiteDb;
if (!audit) repointProcessToSuiteDatabase(suiteDb, suiteServerPaths().sessionDbPath);

await import('../src/core/components/registry.ts');
const fixture = await import('../test/helpers/crawl_persona_fixture.ts');
const { resolvePrincipal, getPermissions } = await import('../src/core/security/permissions.ts');
const { getMenuTreeDatalist } = await import('../src/core/api/handlers/menu.ts');
const { getUserTools } = await import('../src/core/tools/registry.ts');
const { createSession, destroySession, SESSION_COOKIE } = await import(
	'../src/core/security/session_store.ts'
);
const { issueSessionMediaKey } = await import('../src/core/media/protection.ts');
const { ensureSuiteLoginPassword, SUITE_LOGIN_PASSWORD } = await import(
	'../src/core/test_data/suite_login.ts'
);
const { sql } = await import('../src/core/db/postgres.ts');
// the engine's own TOTAL action classification (read_door_acl_tripwire): an audit lets
// through what it marks a read; `mutating`, polymorphic `delegates` and unknown are aborted
const { READ_DOOR_POSTURE } = await import('../src/core/security/read_door.ts');
const auditAllows = (key: string): boolean => {
	const posture = READ_DOOR_POSTURE.get(key)?.posture;
	return posture !== undefined && posture !== 'mutating' && posture !== 'delegates';
};
const { assertTestDatabase } = await import('../src/core/test_data/test_database_marker.ts');
const { armRunCreatedSweep } = await import('../src/core/test_data/run_created_records.ts');
const { getMatrixTableFromTipo } = await import('../src/core/ontology/resolver.ts');

const GATE_PERSONAS: { name: string; userId: number; username: string }[] = [
	{ name: 'root' as const, userId: -1, username: 'root' },
	{
		name: 'admin' as const,
		userId: fixture.CRAWL_ADMIN_USER_ID,
		username: fixture.CRAWL_ADMIN_USERNAME,
	},
	{
		name: 'editor' as const,
		userId: fixture.CRAWL_EDITOR_USER_ID,
		username: fixture.CRAWL_EDITOR_USERNAME,
	},
].filter((p) => (list('--persona') ?? ['root', 'admin', 'editor']).includes(p.name));
const PERSONAS = audit ? await auditPersonas(auditUsers) : GATE_PERSONAS;
/** Sessions this run minted — destroyed at the end (audit: on the real store). */
const mintedTokens: string[] = [];

const findings: Finding[] = [];
let pagesVisited = 0;
let checksRun = 0;
const pendingShots: Promise<void>[] = [];
/** audit: every non-read request the guard aborted, `persona tipo: action model` */
const auditBlocked: string[] = [];

if (!audit) {
	await fixture.installCrawlPersonaFixture();
	// real passwords, so the login journeys use the form, as a user does
	for (const p of PERSONAS) await ensureSuiteLoginPassword(p.username, SUITE_LOGIN_PASSWORD);
}
const server = audit
	? await auditTarget(auditUrl as string, auditEntity as string)
	: await startClientTestServer({
			suiteDb,
			expectedFingerprint: await localSuiteFingerprint(),
			port: await findFreePort(Number.parseInt(flag('--port') ?? '4390', 10)),
			log: (m) => console.log(m),
		});
const executablePath = readEnv('PUPPETEER_EXECUTABLE_PATH');
const browser = await puppeteer.launch({
	headless: !args.includes('--headful'),
	// concurrent pages are background tabs: unthrottled, or idle-callback renders (the inspector) stall
	args: [
		'--no-sandbox',
		'--disable-setuid-sandbox',
		'--disable-background-timer-throttling',
		'--disable-backgrounding-occluded-windows',
		'--disable-renderer-backgrounding',
	],
	...(executablePath ? { executablePath } : { channel: 'chrome' as const }),
});
const hostname = new URL(server.origin).hostname;
if (outDir) mkdirSync(outDir, { recursive: true });

try {
	for (const persona of PERSONAS) await crawlPersona(persona);
} finally {
	await browser.close();
	for (const token of mintedTokens) destroySession(token);
	await server.stop();
	// a failed sweep is a finding (another run wiped the fixture — `bun test`
	// reseeds test3 wholesale: one suite run at a time), never a lost report
	if (!audit)
		await fixture
			.removeCrawlPersonaFixture()
			.catch((err) => add('root', 'fixture', 'teardown', 'sweep', (err as Error).message));
}

// ---- verdict -------------------------------------------------------------
const failedIds = new Set(findings.map((f) => f.id));
// the baseline is the SUITE's; an audit reports everything it saw
const known = audit ? new Map<string, string>() : KNOWN_FAILING;
const intermittent = audit ? new Map<string, string>() : INTERMITTENT;
const tolerated = (id: string) => !strict && (known.has(id) || intermittent.has(id));
const unexpected = findings.filter((f) => !tolerated(f.id));
// a narrowed run did not look everywhere: only a full one can call an entry stale
const narrowed = ['--only', '--persona', '--max', '--journey', '--no-journeys'].some((f) =>
	args.includes(f),
);
const stale = strict || narrowed ? [] : [...known.keys()].filter((id) => !failedIds.has(id));
for (const f of findings)
	console.log(`${tolerated(f.id) ? 'known' : 'FAIL '} ${f.id}\n      ${f.detail}`);
for (const id of stale)
	console.log(`FAIL  ${id}\n      listed in KNOWN_FAILING but passes — remove it`);
console.log(
	`\n${PERSONAS.length} personas, ${pagesVisited} pages, ${checksRun} checks, ${findings.length} findings, ${unexpected.length + stale.length} red.`,
);
if (outDir)
	writeFileSync(
		join(outDir, 'crawl_report.json'),
		JSON.stringify({ audit, pagesVisited, checksRun, findings, stale, auditBlocked }, null, '\t'),
	);
process.exit(unexpected.length + stale.length === 0 ? 0 : 1);

// ---- per persona -----------------------------------------------------------

async function crawlPersona(persona: (typeof PERSONAS)[number]): Promise<void> {
	const principal = await resolvePrincipal(persona.userId);
	const context = await browser.createBrowserContext();
	const token = createSession(
		persona.userId,
		persona.username,
		principal.isGlobalAdmin,
		issueSessionMediaKey(),
	);
	mintedTokens.push(token);
	await context.setCookie({ name: SESSION_COOKIE, value: token, domain: hostname, path: '/' });
	const granted = new Set((await getUserTools(persona.userId)).map((t) => t.name));
	// (tool, caller model) → the lexicographically first offer: chosen independently of page order
	const toolsOpened = new Map<string, ToolCandidate>();

	const { tree_datalist } = await getMenuTreeDatalist(principal);
	const seen = new Set<string>();
	const targets = tree_datalist.filter((item) => {
		if (seen.has(item.tipo)) return false;
		seen.add(item.tipo);
		return onlyTipos === undefined || onlyTipos.includes(item.tipo);
	});
	const sections = targets.filter((t) => t.model === 'section');
	const areas = targets.filter((t) => t.model !== 'section');
	console.log(`\n[${persona.name}] menu: ${sections.length} sections, ${areas.length} areas`);

	// a menu entry whose parent the full menu has but this viewer's lacks is
	// unreachable in the menu UI (the full menu's own roots are not entries)
	const visible = new Set(tree_datalist.map((i) => i.tipo));
	const full = new Set((await getMenuTreeDatalist()).tree_datalist.map((i) => i.tipo));
	for (const item of targets) {
		checksRun++;
		if (item.parent !== null && full.has(item.parent) && !visible.has(item.parent))
			add(
				persona.name,
				item.tipo,
				'menu',
				'orphan',
				`menu parent '${item.parent}' is not visible to this user`,
			);
	}

	const pool = async <T>(items: T[], work: (item: T) => Promise<void>): Promise<void> => {
		const queue = [...items];
		const worker = async () => {
			for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
		};
		await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
	};

	await pool(areas, (area) =>
		visit(
			context,
			persona.name,
			area.tipo,
			'area',
			urlFor(area.tipo, 'list', null, area.config),
		).then(() => {}),
	);
	await pool(maxSections > 0 ? sections.slice(0, maxSections) : sections, async (section) => {
		const listIds = await visit(
			context,
			persona.name,
			section.tipo,
			'list',
			urlFor(section.tipo, 'list', null, section.config),
		);
		const firstId = listIds.length > 0 ? Math.min(...listIds) : null;
		if (firstId === null) return;
		await visit(
			context,
			persona.name,
			section.tipo,
			'edit',
			urlFor(section.tipo, 'edit', firstId, null),
			{
				principal,
				granted,
				toolsOpened,
			},
		);
	});
	// one at a time, after the walk: concurrent tool opens flake (timeouts, torn responses)
	for (const key of [...toolsOpened.keys()].sort()) {
		const c = toolsOpened.get(key) as ToolCandidate;
		await openTool(context, persona.name, c.from, c.url, c.name, c.caller);
	}

	if (persona.userId !== -1)
		await (audit
			? auditOracle(context, persona.name, principal)
			: oracle(context, persona.name, principal, granted));
	await context.close();
	if (!audit && !args.includes('--no-journeys'))
		await runJourneys(persona, principal.isGlobalAdmin);
}

/** Audit oracle: one section of the full menu this user holds no grant on must refuse. */
async function auditOracle(
	context: BrowserContext,
	who: string,
	principal: Awaited<ReturnType<typeof resolvePrincipal>>,
): Promise<void> {
	for (const item of (await getMenuTreeDatalist()).tree_datalist) {
		if (item.model !== 'section' || (await getPermissions(principal, item.tipo, item.tipo)) !== 0)
			continue;
		await expectRefused(
			context,
			who,
			item.tipo,
			'no_grant',
			urlFor(item.tipo, 'list', null, item.config),
		);
		return;
	}
}

/** Audit personas: EXISTING users of the staging install, by username. */
async function auditPersonas(
	usernames: string[],
): Promise<{ name: string; userId: number; username: string }[]> {
	const out = [];
	for (const username of usernames) {
		const rows = (await sql`
			SELECT section_id FROM matrix_users
			WHERE section_tipo = 'dd128' AND string->'dd132'->0->>'value' = ${username} LIMIT 1
		`) as { section_id: number }[];
		const row = rows[0];
		if (row === undefined) throw new Error(`--as: no user '${username}' in this installation`);
		out.push({ name: username, userId: Number(row.section_id), username });
	}
	return out;
}

/** Audit target: --url must answer /health with the --entity the operator named. */
async function auditTarget(
	origin: string,
	entity: string,
): Promise<{ origin: string; stop: () => Promise<void> }> {
	const base = origin.replace(/\/+$/, '');
	const health = (await (await fetch(`${base}/health`)).json().catch(() => null)) as {
		entity?: string;
	} | null;
	if (health?.entity !== entity)
		throw new Error(
			`REFUSING to audit ${base}: /health names entity '${health?.entity ?? '<none>'}', not '${entity}'`,
		);
	console.log(`AUDIT (read-only) of ${base} — entity '${entity}'`);
	return { origin: base, stop: async () => {} };
}

/** Audit guard: abort every API request that is not a read. */
async function guardPage(page: Page, who: string, tipo: string): Promise<void> {
	if (!audit) return;
	await page.setRequestInterception(true);
	page.on('request', (req) => {
		if (req.method() !== 'POST' || !req.url().includes('/api/')) return void req.continue();
		let action = '';
		let model = '';
		let api = 'dd_core_api'; // the dispatcher's own default
		try {
			const rqo = JSON.parse(req.postData() ?? '{}');
			action = String(rqo.action ?? '');
			model = String(rqo.source?.model ?? '');
			api = String(rqo.dd_api ?? api);
		} catch {}
		if (auditAllows(`${api}:${action}`)) return void req.continue();
		auditBlocked.push(`${who} ${tipo}: ${action || '?'} ${model}`);
		return void req.abort('blockedbyclient');
	});
}

/** Each journey in its own browser context with its own session (logout ends one). */
async function runJourneys(
	persona: (typeof PERSONAS)[number],
	isGlobalAdmin: boolean,
): Promise<void> {
	const only = list('--journey');
	for (const [name, journey] of Object.entries(JOURNEYS)) {
		// journeys run on the suite only, where persona names are the gate's three
		if (!journey.personas.includes(persona.name as PersonaName) || (only && !only.includes(name)))
			continue;
		const context = await browser.createBrowserContext();
		if (!journey.anonymous) {
			const token = createSession(
				persona.userId,
				persona.username,
				isGlobalAdmin,
				issueSessionMediaKey(),
			);
			await context.setCookie({ name: SESSION_COOKIE, value: token, domain: hostname, path: '/' });
		}
		const page = await context.newPage();
		await page.setViewport({ width: 1400, height: 1000 });
		const signals = watch(page, journey.acceptDialogs === true);
		console.log(`  ${persona.name} journey ${name}`);
		checksRun++;
		try {
			await journey.run(journeyContext(page, context, persona));
		} catch (err) {
			add(
				persona.name,
				'journey',
				name,
				'outcome',
				(err as Error).message.split('\n')[0] ?? 'failed',
				page,
			);
		}
		signals.apiErrors = signals.apiErrors.filter(
			(e) => !(journey.expectedApiErrors ?? []).includes(e.code),
		);
		await reportSignals(signals, persona.name, 'journey', name, page, false);
		await closePage(page);
		await context.close();
	}
}

function journeyContext(
	page: Page,
	context: BrowserContext,
	persona: (typeof PERSONAS)[number],
): JourneyContext {
	return {
		page,
		context,
		persona: { ...persona, name: persona.name as PersonaName, password: SUITE_LOGIN_PASSWORD },
		origin: server.origin,
		url: (tipo, mode, sectionId) => urlFor(tipo, mode, sectionId ?? null, null),
		server: {
			async readValue(table, sectionTipo, sectionId, column, tipo) {
				const rows = (await sql.unsafe(
					`SELECT "${column}"->$3 AS v FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`,
					[sectionTipo, sectionId, tipo],
				)) as { v: unknown }[];
				return rows[0]?.v ?? null;
			},
			async recordExists(table, sectionTipo, sectionId) {
				const rows = await sql.unsafe(
					`SELECT 1 FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`,
					[sectionTipo, sectionId],
				);
				return rows.length > 0;
			},
			async armSweep(sectionTipo) {
				await assertTestDatabase('feature_crawl.armSweep');
				const table = await getMatrixTableFromTipo(sectionTipo);
				if (table === null) throw new Error(`armSweep: '${sectionTipo}' has no matrix table`);
				const sweeper = await armRunCreatedSweep(sectionTipo, table);
				return async () => {
					await sweeper.sweep();
				};
			},
			sweep: fixture.sweepCrawlRecord,
		},
		fixture: {
			editSection: fixture.CRAWL_EDIT_SECTION,
			recordInA: fixture.CRAWL_RECORD_IN_A,
			recordInB: fixture.CRAWL_RECORD_IN_B,
			projectA: fixture.CRAWL_PROJECT_A,
			projectB: fixture.CRAWL_PROJECT_B,
			readonlyComponent: fixture.CRAWL_READONLY_COMPONENT,
			textComponent: fixture.CRAWL_TEXT_COMPONENT,
			filterComponent: fixture.CRAWL_FILTER_COMPONENT,
			createSection: fixture.CRAWL_CREATE_SECTION,
			createFilter: fixture.CRAWL_CREATE_FILTER,
		},
	};
}

/** The permission oracle: refusals by direct URL. */
async function oracle(
	context: BrowserContext,
	who: string,
	principal: Awaited<ReturnType<typeof resolvePrincipal>>,
	granted: Set<string>,
): Promise<void> {
	const denied = fixture.CRAWL_DENIED_SECTION;
	if ((await getPermissions(principal, denied, denied)) === 0)
		await expectRefused(context, who, denied, 'no_grant', urlFor(denied, 'list', null, null));
	if (!principal.isGlobalAdmin) {
		const section = fixture.CRAWL_EDIT_SECTION;
		await expectRefused(
			context,
			who,
			section,
			'other_project_record',
			urlFor(section, 'edit', fixture.CRAWL_RECORD_IN_B, null),
			fixture.CRAWL_RECORD_IN_B,
		);
		// the list must hold the in-project record and never the other project's
		const ids = await visit(context, who, section, 'list', urlFor(section, 'list', null, null));
		checksRun++;
		if (ids.includes(fixture.CRAWL_RECORD_IN_B))
			add(
				who,
				section,
				'list',
				'project_filter',
				`record ${fixture.CRAWL_RECORD_IN_B} of another project is listed`,
			);
		if (!ids.includes(fixture.CRAWL_RECORD_IN_A))
			add(
				who,
				section,
				'list',
				'project_filter',
				`own-project record ${fixture.CRAWL_RECORD_IN_A} is missing`,
			);
	}
	const rootTools = (await getUserTools(-1)).map((t) => t.name);
	const ungranted = rootTools.find((name) => !granted.has(name));
	if (ungranted !== undefined) {
		const page = await context.newPage();
		const signals = watch(page);
		await page.goto(
			`${urlFor(fixture.CRAWL_EDIT_SECTION, 'edit', fixture.CRAWL_RECORD_IN_A, null)}&tool=${ungranted}`,
			{ waitUntil: 'networkidle0', timeout: PAGE_TIMEOUT },
		);
		await settle(page);
		checksRun++;
		if ((await page.$(`.wrapper_tool.${ungranted}`)) !== null)
			add(
				who,
				fixture.CRAWL_EDIT_SECTION,
				'edit',
				`tool_deeplink:${ungranted}`,
				'ungranted tool opened by ?tool=',
				page,
			);
		signals.apiErrors = signals.apiErrors.filter((e) => e.code !== 'tool.not_authorized');
		await reportSignals(signals, who, fixture.CRAWL_EDIT_SECTION, 'tool_deeplink', page, true);
		await closePage(page);
	}
}

async function expectRefused(
	context: BrowserContext,
	who: string,
	tipo: string,
	check: string,
	url: string,
	sectionId?: number,
): Promise<void> {
	const page = await context.newPage();
	await guardPage(page, who, tipo);
	const signals = watch(page);
	await page.goto(url, { waitUntil: 'networkidle0', timeout: PAGE_TIMEOUT }).catch(() => {});
	await settle(page);
	checksRun++;
	const state = await page.evaluate(async (id: number | null) => {
		const spec = '/dedalo/core/common/js/instances.js'; // the page's own module, not a repo path
		const { get_all_instances } = (await import(spec)) as { get_all_instances: () => unknown[] };
		// biome-ignore lint/suspicious/noExplicitAny: live client instances
		const shown = (get_all_instances() as any[]).filter(
			(i) =>
				String(i.model).startsWith('component_') &&
				(id === null || Number(i.section_id) === id) &&
				i.data?.value?.length > 0,
		).length;
		const refusal = document.querySelector('.no_access, .no_access_error') !== null;
		return { shown, refusal };
	}, sectionId ?? null);
	const permAnswer = signals.apiErrors.some((e) => e.code.startsWith('perm.'));
	if (state.shown > 0)
		add(
			who,
			tipo,
			'oracle',
			check,
			`served ${state.shown} component value(s) it must refuse`,
			page,
		);
	else if (!state.refusal && !permAnswer)
		add(who, tipo, 'oracle', check, 'no refusal shown (no .no_access and no perm.* answer)', page);
	signals.apiErrors = signals.apiErrors.filter((e) => !e.code.startsWith('perm.'));
	await reportSignals(signals, who, tipo, `oracle_${check}`, page, true);
	await closePage(page);
}

/**
 * Open one page, judge it, return the section_ids of the records it shows.
 * In edit mode (`edit` given) also judges components, inspector and tools.
 */
async function visit(
	context: BrowserContext,
	who: string,
	tipo: string,
	mode: string,
	url: string,
	edit?: {
		principal: Awaited<ReturnType<typeof resolvePrincipal>>;
		granted: Set<string>;
		toolsOpened: Map<string, ToolCandidate>;
	},
): Promise<number[]> {
	const page = await context.newPage();
	await page.setViewport({ width: 1400, height: 1000 });
	await guardPage(page, who, tipo);
	const signals = watch(page);
	pagesVisited++;
	console.log(`  ${who} ${mode} ${tipo}`);
	try {
		await page.goto(url, { waitUntil: 'networkidle0', timeout: PAGE_TIMEOUT });
		await settle(page);
		await scrollAll(page);
		const instances = await liveInstances(page);
		const ids = [
			...new Set(
				instances
					.filter(
						(i) =>
							i.section_tipo === tipo && i.model.startsWith('component_') && i.section_id !== null,
					)
					.map((i) => Number(i.section_id))
					.filter((n) => Number.isFinite(n) && n > 0),
			),
		];
		checksRun++;
		if (
			mode !== 'area' &&
			!instances.some((i) => i.model === 'section' || i.model.startsWith('area'))
		)
			add(who, tipo, mode, 'blank', 'no section instance rendered', page);
		if (edit) {
			await checkComponents(page, who, tipo, instances, edit.principal);
			await checkInspector(page, who, tipo);
			await checkTools(context, page, who, tipo, url, instances, edit.granted, edit.toolsOpened);
		}
		await reportSignals(signals, who, tipo, mode, page, false);
		return ids;
	} catch (err) {
		add(who, tipo, mode, 'load', (err as Error).message.split('\n')[0] ?? 'load failed', page);
		return [];
	} finally {
		await closePage(page);
	}
}

interface ToolCandidate {
	name: string;
	from: string;
	url: string;
	caller: LiveInstance;
}
interface LiveInstance {
	id: string;
	model: string;
	tipo: string;
	section_tipo: string;
	section_id: string | number | null;
	mode: string;
	status: string;
	permissions: number | null;
	hasNode: boolean;
	errorPanel: boolean;
	enabledInputs: number;
	tools: string[];
	/** a dataframe's main component (its grant is the main's) */
	callerTipo: string | null;
}

async function liveInstances(page: Page): Promise<LiveInstance[]> {
	return await page.evaluate(async () => {
		const spec = '/dedalo/core/common/js/instances.js'; // the page's own module, not a repo path
		const { get_all_instances } = (await import(spec)) as { get_all_instances: () => unknown[] };
		// biome-ignore lint/suspicious/noExplicitAny: live client instances
		return (get_all_instances() as any[]).map((i) => {
			const node = i.node as HTMLElement | null | undefined;
			return {
				id: String(i.id),
				model: String(i.model ?? ''),
				tipo: String(i.tipo ?? ''),
				section_tipo: String(i.section_tipo ?? ''),
				section_id: i.section_id ?? null,
				mode: String(i.mode ?? ''),
				status: String(i.status ?? ''),
				permissions:
					typeof i.permissions === 'number' ? i.permissions : (i.context?.permissions ?? null),
				hasNode: !!node?.isConnected,
				errorPanel: !!node?.querySelector?.('.content_data_error, .api_error_panel'),
				enabledInputs:
					node?.querySelectorAll?.(
						'input:not([type=hidden]):not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), select:not([disabled]), [contenteditable=true]',
					).length ?? 0,
				tools: [...(i.context?.tools ?? []), ...(i.tools ?? [])].map(
					(t: { name: string }) => t.name,
				),
				callerTipo: i.caller?.tipo ?? null,
			};
		});
	});
}

/** One representative instance per component model, judged against the server's grant. */
async function checkComponents(
	page: Page,
	who: string,
	tipo: string,
	instances: LiveInstance[],
	principal: Awaited<ReturnType<typeof resolvePrincipal>>,
): Promise<void> {
	const components = instances.filter(
		(i) => i.model.startsWith('component_') && i.mode === 'edit' && i.section_tipo === tipo,
	);
	checksRun++;
	if (components.length === 0) {
		add(who, tipo, 'edit', 'components', 'edit page rendered no component', page);
		return;
	}
	const byModel = new Map<string, LiveInstance>();
	// the registry also holds detached instances (replaced on refresh): prefer one on the page
	for (const c of components) {
		const current = byModel.get(c.model);
		if (!current || (!current.hasNode && c.hasNode)) byModel.set(c.model, c);
	}
	for (const c of components) {
		// every instance's level is checked; render health on the representatives
		// a dataframe is a companion of its main component and carries the main's grant
		const grantTipo = c.model === 'component_dataframe' && c.callerTipo ? c.callerTipo : c.tipo;
		const level = await getPermissions(principal, tipo, grantTipo);
		checksRun++;
		if (level === 0)
			add(
				who,
				tipo,
				'edit',
				`component_leak:${c.tipo}`,
				`${c.model} ${c.tipo} rendered with no grant`,
				page,
			);
		// ABOVE the grant is an escalation; BELOW is the engine's own cap (consultation-only
		// sections, derived fields like ontology7, dataframe companions) — by design
		else if (c.permissions !== null && c.permissions > level)
			add(
				who,
				tipo,
				'edit',
				`component_level:${c.tipo}`,
				`${c.model} ${c.tipo} client level ${c.permissions} ABOVE server grant ${level}`,
				page,
			);
		if (level === 1 && c.enabledInputs > 0)
			add(
				who,
				tipo,
				'edit',
				`component_readonly:${c.tipo}`,
				`${c.model} ${c.tipo} is read-only (1) but has ${c.enabledInputs} enabled input(s)`,
				page,
			);
	}
	for (const c of byModel.values()) {
		checksRun++;
		// a node out of the DOM is normal (components leave it when scrolled away)
		if (c.status !== 'rendered')
			add(
				who,
				tipo,
				'edit',
				`component_render:${c.model}`,
				`${c.tipo} status '${c.status}' (not rendered)`,
				page,
			);
		else if (c.errorPanel)
			add(
				who,
				tipo,
				'edit',
				`component_error:${c.model}`,
				`${c.tipo} renders an error panel`,
				page,
			);
	}
}

/** Open every collapsed inspector block the way a user does; a failure panel is red. */
async function checkInspector(page: Page, who: string, tipo: string): Promise<void> {
	// the inspector paints after the section, and only in a VISIBLE tab (viewport
	// observers never fire in a background one): front, then wait
	await page.bringToFront().catch(() => {});
	const hasInspector = await page
		.waitForSelector('#inspector', { timeout: 30_000 })
		.then(() => true)
		// a page that re-navigates after load destroys the wait's context: look again once settled
		.catch(async () => {
			await settle(page);
			return (await page.$('#inspector').catch(() => null)) !== null;
		});
	// select a component (its LABEL: the body may hold links that navigate away),
	// so the component-history block has a subject
	await page.evaluate(() => {
		document.querySelector<HTMLElement>('.wrapper_component.edit > .label')?.click();
	});
	await page.waitForNetworkIdle({ idleTime: 300, timeout: 10_000 }).catch(() => {});
	const heads = await page.$$('.inspector [class*="_head"].icon_arrow:not(.up)');
	for (const head of heads) {
		await head.click().catch(() => {});
		await page.waitForNetworkIdle({ idleTime: 300, timeout: 15_000 }).catch(() => {});
	}
	checksRun++;
	const failures = await page.$$eval('.inspector .inspector_block_failure', (els) =>
		els.map((e) => (e.textContent ?? '').trim().slice(0, 160)),
	);
	for (const f of failures) add(who, tipo, 'edit', 'inspector', f, page);
	if (!hasInspector) add(who, tipo, 'edit', 'inspector', 'edit page has no inspector', page);
}

/** Offered tools must be granted; each (tool, caller model) pair is queued to open once per persona. */
async function checkTools(
	context: BrowserContext,
	page: Page,
	who: string,
	tipo: string,
	url: string,
	instances: LiveInstance[],
	granted: Set<string>,
	opened: Map<string, ToolCandidate>,
): Promise<void> {
	const offered = new Set(instances.flatMap((i) => i.tools));
	for (const name of offered) {
		checksRun++;
		if (!granted.has(name))
			add(
				who,
				tipo,
				'edit',
				`tool_offered:${name}`,
				`offers ${name}, which getUserTools does not grant`,
				page,
			);
	}
	// per caller MODEL: a tool breaks per caller kind; keep the first (section, caller) offer
	for (const caller of instances)
		for (const name of caller.tools) {
			if (!granted.has(name)) continue;
			const key = `${name}@${caller.model}`;
			const current = opened.get(key);
			if (!current || `${tipo}|${caller.tipo}` < `${current.from}|${current.caller.tipo}`)
				opened.set(key, { name, from: tipo, url, caller });
		}
}

async function openTool(
	context: BrowserContext,
	who: string,
	from: string,
	url: string,
	name: string,
	caller: LiveInstance,
): Promise<void> {
	// ids name the TOOL and its caller model, never the section (order-dependent)
	const tipo = `tools@${caller.model}`;
	const page = await context.newPage();
	await page.setViewport({ width: 1400, height: 1000 });
	await guardPage(page, who, `${from} ${name}`);
	const signals = watch(page);
	checksRun++;
	try {
		await page.goto(url, { waitUntil: 'networkidle0', timeout: PAGE_TIMEOUT });
		await settle(page);
		await scrollAll(page);
		const popup = context
			.waitForTarget((t) => t.opener() === page.target(), { timeout: 15_000 })
			.then((t) => t.page())
			.catch(() => null);
		const result = await page.evaluate(
			async (
				toolName: string,
				c: { tipo: string; section_tipo: string; mode: string; model: string },
				modalOnly: boolean,
			) => {
				const spec = '/dedalo/core/common/js/instances.js'; // the page's own module, not a repo path
				const { get_all_instances } = (await import(spec)) as {
					get_all_instances: () => unknown[];
				};
				const toolSpec = '/dedalo/core/tools_common/js/tool_common.js';
				const { open_tool } = (await import(toolSpec)) as {
					open_tool: (o: object) => Promise<unknown>;
				};
				// biome-ignore lint/suspicious/noExplicitAny: live client instances
				const offers = (i: any) =>
					[...(i.context?.tools ?? []), ...(i.tools ?? [])].find(
						(t: { name: string }) => t.name === toolName,
					);
				// biome-ignore lint/suspicious/noExplicitAny: live client instances
				const instance = (get_all_instances() as any[]).find(
					(i) => i.tipo === c.tipo && i.model === c.model && offers(i),
				);
				if (!instance) return 'caller instance gone after reload';
				instance.node?.scrollIntoView?.({ block: 'center' });
				const tool_context = offers(instance);
				const openAs = String(tool_context.properties?.open_as ?? 'modal');
				// audit: a window's first requests would race the write guard
				if (modalOnly && openAs !== 'modal') return 'skipped';
				void open_tool({ tool_context, caller: instance });
				return openAs;
			},
			name,
			{
				tipo: caller.tipo,
				section_tipo: caller.section_tipo,
				mode: caller.mode,
				model: caller.model,
			},
			audit,
		);
		if (result === 'skipped') {
			console.log(`    audit: ${name} opens a window — not opened`);
			await closePage(page);
			return;
		}
		if (result !== 'modal' && result !== 'window' && result !== 'tab') throw new Error(result);
		const toolPage = result === 'modal' ? page : ((await popup) ?? page);
		const toolSignals = toolPage === page ? signals : watch(toolPage);
		await toolPage.waitForSelector(`.wrapper_tool.${name}`, { timeout: 30_000 });
		await settle(toolPage);
		const panel = await toolPage.$(
			`.wrapper_tool.${name} .content_data_error, .wrapper_tool.${name} .tool_error, .wrapper_tool.${name} .api_error_panel`,
		);
		if (panel)
			add(
				who,
				tipo,
				'tool',
				`tool_error:${name}`,
				`tool rendered its error panel (caller ${caller.model} ${caller.tipo} on ${from}): ${(
					(await panel.evaluate((n) => n.textContent ?? '').catch(() => '')) as string
				)
					.trim()
					.slice(0, 160)}`,
				toolPage,
			);
		await reportSignals(toolSignals, who, tipo, `tool:${name}`, toolPage, false);
		if (toolPage !== page) await closePage(toolPage);
	} catch (err) {
		add(
			who,
			tipo,
			'tool',
			`tool_open:${name}`,
			(err as Error).message.split('\n')[0] ?? 'open failed',
			page,
		);
	}
	await reportSignals(signals, who, tipo, `tool:${name}`, page, false);
	await closePage(page);
}

// ---- page plumbing ------------------------------------------------------

function urlFor(tipo: string, mode: string, sectionId: number | null, config: unknown): string {
	const q = new URLSearchParams({ tipo, mode });
	if (sectionId !== null) q.set('section_id', String(sectionId));
	const vars = (config as { url_vars?: Record<string, unknown> } | null)?.url_vars;
	for (const [k, v] of Object.entries(vars ?? {})) q.set(k, String(v));
	return `${server.origin}/dedalo/core/page/?${q.toString()}`;
}

function watch(page: Page, acceptDialogs = false): PageSignals {
	const signals: PageSignals = { problems: [], notes: [], apiErrors: [] };
	// a blocking alert would freeze CDP; a crawl never confirms, a journey may
	page.on('dialog', (d) => (acceptDialogs ? d.accept() : d.dismiss()));
	page.on('pageerror', (err) =>
		signals.problems.push(`pageerror: ${String((err as Error).message ?? err).slice(0, 300)}`),
	);
	page.on('console', (msg) => {
		if (msg.type() === 'error') signals.notes.push(msg.text().slice(0, 200));
	});
	page.on('response', (res) => {
		if (!res.url().includes('/api/') || !(res.headers()['content-type'] ?? '').includes('json'))
			return;
		void res
			.json()
			.then((body: { ok?: boolean; error?: { code?: string } }) => {
				if (body?.ok !== false) return;
				// name the request: action + what it asked for, so a finding has an address
				let what = res.url().replace(server.origin, '');
				try {
					const rqo = JSON.parse(res.request().postData() ?? '{}');
					what = `${rqo.action ?? '?'} ${rqo.source?.model ?? ''} ${rqo.source?.section_tipo ?? ''}/${rqo.source?.tipo ?? ''}${rqo.source?.section_id ? `/${rqo.source.section_id}` : ''}`;
				} catch {}
				signals.apiErrors.push({ url: what, code: body.error?.code ?? 'unknown' });
			})
			.catch(() => {});
	});
	return signals;
}

async function settle(page: Page): Promise<void> {
	await page.waitForNetworkIdle({ idleTime: 500, timeout: 20_000 }).catch(() => {});
}

/** Components build lazily as they enter the viewport: scroll like a reader. */
async function scrollAll(page: Page): Promise<void> {
	for (let step = 0; step < 30; step++) {
		const atEnd = await page.evaluate(() => {
			window.scrollBy(0, window.innerHeight * 0.9);
			return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
		});
		await page.waitForNetworkIdle({ idleTime: 250, timeout: 10_000 }).catch(() => {});
		if (atEnd) break;
	}
	await page.evaluate(() => window.scrollTo(0, 0));
}

async function reportSignals(
	signals: PageSignals,
	who: string,
	tipo: string,
	mode: string,
	page: Page,
	refusalExpected: boolean,
): Promise<void> {
	checksRun++;
	const captured = await page
		.evaluate(() => {
			// biome-ignore lint/suspicious/noExplicitAny: client error buffer
			const buffer = ((window as any).dedalo_js_errors ?? []) as {
				type?: string;
				message?: string;
			}[];
			const panels = [
				...document.querySelectorAll('.api_error_panel, .page_error_container, .error_alert'),
			].map((e) => (e.textContent ?? '').trim().slice(0, 160));
			return {
				js: buffer.filter((e) => e.type !== 'console').map((e) => String(e.message).slice(0, 200)),
				panels,
			};
		})
		.catch(() => ({ js: [] as string[], panels: [] as string[] }));
	for (const p of [...new Set([...signals.problems, ...captured.js])])
		add(who, tipo, mode, 'js_error', p, page);
	for (const e of signals.apiErrors)
		add(who, tipo, mode, `api:${e.code}`, `ok:false: ${e.url}`, page);
	// an ok:false is the finding; its panel is how the client SHOWS it, and under load
	// the client sometimes shows it otherwise (the error-report bubble) — so a panel is
	// judged only where no api error explains it (a client-side failure)
	if (!refusalExpected && !signals.apiErrors.length)
		for (const p of captured.panels) add(who, tipo, mode, 'error_panel', p, page);
	signals.problems = [];
	signals.apiErrors = [];
}

function add(
	who: string,
	tipo: string,
	mode: string,
	check: string,
	detail: string,
	page?: Page,
): void {
	const id = `${who}:${tipo}:${mode}:${check}`;
	if (findings.some((f) => f.id === id && f.detail === detail)) return;
	findings.push({ id, detail });
	if (outDir && page && !page.isClosed())
		pendingShots.push(
			page.screenshot({ path: join(outDir, `${id.replace(/[^\w.-]+/g, '_')}.png`) }).then(
				() => {},
				() => {},
			),
		);
}

/** Screenshots are taken asynchronously: settle them before a page goes. */
async function closePage(page: Page): Promise<void> {
	await Promise.all(pendingShots.splice(0));
	await page.close().catch(() => {});
}
