/**
 * tool_uca_maps — every browser call of a readOnly action is sent once with a
 * budget of its own. A readOnly action is never ledgered: a resend re-runs it,
 * and a refusal it answered retryable would come back as outcome_unknown. The
 * census reads the tool's browser modules as text (they import core's client,
 * which needs a DOM) and the action table as the server sees it.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_KEYS } from '../../src/config/catalog/media.ts';
import { GEO_ORIGINS, GEO_SERVICE_IDS, GEO_SERVICES } from '../../src/core/geo_services/table.ts';
import { HARVEST_DEFAULT_TIMEOUT_MS } from '../../src/core/harvest/harvest.ts';
import { MIN_INTERVAL_MS } from '../../src/core/harvest/pacing.ts';
import { unguarded } from '../../src/core/tools/reason_keys.ts';
import { TOOL_BINARY_TIMEOUT_MS } from '../../tools/tool_uca_maps/server/gdal.ts';
import { loadTool } from './fixtures/tool_uca_maps/helpers.ts';
import {
	callArguments,
	codeOf,
	localImports,
	loopSpans,
	moduleFunctions,
	priceServer,
	productMs,
} from './fixtures/tool_uca_maps/source_census.ts';

const JS_DIR = join(import.meta.dir, '../../tools/tool_uca_maps/js');
const SERVER_DIR = join(import.meta.dir, '../../tools/tool_uca_maps/server');

/** The browser module of the budgets, loaded as data: it imports nothing. */
// biome-ignore lint/suspicious/noExplicitAny: a plain browser module without declarations
const budgets: Record<string, any> = await import(join(JS_DIR, 'request_budgets.js'));

/** What a budget leaves over the server's worst case, for the answer to travel back. */
const ROOM_MS = 10_000;

interface CallSite {
	file: string;
	action: string;
	retries: string | null;
	timeout: string | null;
}

/** The top-level `key : value` of a call's argument (nested `options` skipped). */
function topLevel(argument: string, key: string): string | null {
	let depth = 0;
	for (const line of argument.split('\n')) {
		const match = depth === 1 ? new RegExp(`^\\s*${key}\\s*:\\s*([^,\\n]+)`).exec(line) : null;
		if (match) return (match[1] as string).trim();
		for (const char of line) {
			if (char === '{') depth++;
			else if (char === '}') depth--;
		}
	}
	return null;
}

/** readOnly actions that keep core's default per-attempt timeout, and why. */
const DEFAULT_TIMEOUT: Readonly<Record<string, string>> = Object.freeze({
	get_image_file: 'a read of a file on this server: no third party, no binary',
});

/** The Roman panel picks its search action from the source: the three names it can hold. */
const ROMAN_SEARCH_ACTIONS = ['search_pleiades', 'search_pelagios', 'search_dare'];

function callSites(): CallSite[] {
	const sites: CallSite[] = [];
	for (const file of readdirSync(JS_DIR).filter((name) => name.endsWith('.js'))) {
		const source = readFileSync(join(JS_DIR, file), 'utf8');
		for (const argument of callArguments(source)) {
			const action = topLevel(argument, 'action');
			const retries = topLevel(argument, 'retries');
			const timeout = topLevel(argument, 'timeout');
			const names =
				action === 'action' && file === 'roman_empire.js'
					? ROMAN_SEARCH_ACTIONS
					: [String(action).replace(/^'|'$/g, '')];
			for (const name of names) sites.push({ file, action: name, retries, timeout });
		}
	}
	return sites;
}

describe('tool_uca_maps request budgets — every readOnly call', () => {
	test('the census finds the calls it reads, every action named', () => {
		const sites = callSites();
		expect(sites.length).toBeGreaterThan(15);
		for (const site of sites) expect(site.action).toMatch(/^(?!null$)[a-z_]+$/);
		// the Roman panel still picks among its three searches by source
		const roman = readFileSync(join(JS_DIR, 'roman_empire.js'), 'utf8');
		for (const name of ROMAN_SEARCH_ACTIONS) expect(roman).toContain(`'${name}'`);
	});

	test('is sent once, with a budget of its own', async () => {
		const { apiActions } = await loadTool();
		const readOnly = new Set(
			Object.entries(apiActions)
				.filter(([, spec]) => spec.readOnly === true)
				.map(([name]) => name),
		);
		const offenders = callSites()
			.filter((site) => readOnly.has(site.action))
			.filter(
				(site) =>
					site.retries !== '1' || (site.timeout === null) !== site.action in DEFAULT_TIMEOUT,
			)
			.map(
				(site) => `${site.file}: ${site.action} (retries ${site.retries}, timeout ${site.timeout})`,
			);
		expect(offenders).toEqual([]);
	});

	test('every readOnly action the server offers is called from the browser', async () => {
		const { apiActions } = await loadTool();
		const called = new Set(callSites().map((site) => site.action));
		const uncalled = Object.entries(apiActions)
			.filter(([name, spec]) => spec.readOnly === true && !called.has(name))
			.map(([name]) => name);
		expect(uncalled).toEqual([]);
	});
});

/** The budget each action's calls name; one the census finds and this omits is red. */
const BUDGET_OF: Readonly<Record<string, string>> = Object.freeze({
	get_capabilities: 'LOOKUP_TIMEOUT_MS',
	get_wms_layers: 'LOOKUP_TIMEOUT_MS',
	get_catastro_parcel: 'LOOKUP_TIMEOUT_MS',
	get_administrative_unit: 'LOOKUP_TIMEOUT_MS',
	search_places: 'LOOKUP_TIMEOUT_MS',
	get_elevation: 'LOOKUP_TIMEOUT_MS',
	search_pleiades: 'LOOKUP_TIMEOUT_MS',
	search_pelagios: 'LOOKUP_TIMEOUT_MS',
	search_dare: 'LOOKUP_TIMEOUT_MS',
	get_pleiades_place: 'LOOKUP_TIMEOUT_MS',
	vector_download: 'CONVERSION_TIMEOUT_MS',
	raster_download: 'CONVERSION_TIMEOUT_MS',
	object_pdf_report: 'CONVERSION_TIMEOUT_MS',
	get_image_overlay: 'CONVERSION_TIMEOUT_MS',
	upload_vector_layer: 'UPLOAD_TIMEOUT_MS',
});

/** Core's robots.txt deadline: not exported, so read where it is declared. */
function coreRobotsTimeoutMs(): number {
	const source = readFileSync(join(import.meta.dir, '../../src/core/harvest/robots.ts'), 'utf8');
	const match = /const ROBOTS_TIMEOUT_MS = ([0-9_]+);/.exec(source);
	expect(match).not.toBeNull();
	return Number((match?.[1] ?? '').replaceAll('_', ''));
}

/** Every one of core's geo services the tool's server code names. */
function askedGeoServices(): string[] {
	const text = readdirSync(SERVER_DIR)
		.filter((name) => name.endsWith('.ts'))
		.map((name) => readFileSync(join(SERVER_DIR, name), 'utf8'))
		.join('\n');
	return GEO_SERVICE_IDS.filter((id) => text.includes(`'${id}'`));
}

let serverSourceCache: ReadonlyMap<string, string> | undefined;

/** Server modules, keyed by file name, comments stripped: read once, they do not change in a run. */
function serverSources(): ReadonlyMap<string, string> {
	serverSourceCache ??= new Map(
		readdirSync(SERVER_DIR)
			.filter((name) => name.endsWith('.ts'))
			.map((name) => [name, codeOf(readFileSync(join(SERVER_DIR, name), 'utf8'))]),
	);
	return serverSourceCache;
}

/** An action and the name of its handler, as index.ts declares them. */
interface HandledAction {
	action: string;
	handler: string;
}

/** The actions whose handler each server module exports, read off index.ts. */
async function actionsByModule(): Promise<Map<string, HandledAction[]>> {
	const { apiActions } = await loadTool();
	const index = readFileSync(join(SERVER_DIR, 'index.ts'), 'utf8');
	const byModule = new Map<string, HandledAction[]>();
	for (const action of Object.keys(apiActions)) {
		const handler = new RegExp(`\\b${action}: \\{[^}]*\\bhandler: (\\w+)`).exec(index)?.[1];
		const from = new RegExp(`import \\{[^}]*\\b${handler}\\b[^}]*\\} from '\\./([a-z_]+\\.ts)'`);
		const file = handler === undefined ? undefined : from.exec(index)?.[1];
		expect(file, `the module of ${action}'s handler`).toBeDefined();
		const entry = { action, handler: handler as string };
		byModule.set(file as string, [...(byModule.get(file as string) ?? []), entry]);
	}
	return byModule;
}

/**
 * One harvest hop at our own pace: robots.txt, the turn at the site (our floor
 * between two requests), the fetch. A redirect is another hop and a site's
 * Crawl-delay a longer turn: neither is budgeted, as no lookup could outlast them
 * and keep data_manager's busy cue.
 */
function harvestHopMs(timeoutMs: number): number {
	return coreRobotsTimeoutMs() + MIN_INTERVAL_MS + timeoutMs;
}

interface HarvestSite {
	file: string;
	actions: string[];
	timeoutMs: number;
}

/**
 * The actions each module's harvests serve: a handler module's own actions; a helper
 * module (no handler) inherits every action whose module imports it, at any depth.
 * A handler module imported for a flag does not lend its harvests to the importer.
 */
async function harvestActions(): Promise<Map<string, string[]>> {
	const sources = serverSources();
	const own = await actionsByModule();
	const reaching = new Map<string, Set<string>>();
	for (const [handlerFile, handled] of own) {
		const actions = handled.map((entry) => entry.action);
		const walk = (file: string, seen: Set<string>): void => {
			if (seen.has(file)) return;
			seen.add(file);
			const into = reaching.get(file) ?? new Set<string>();
			for (const action of actions) into.add(action);
			reaching.set(file, into);
			for (const next of localImports(sources.get(file) ?? '')) walk(next, seen);
		};
		walk(handlerFile, new Set());
	}
	return new Map(
		[...reaching].map(([file, actions]) => [
			file,
			own.get(file)?.map((entry) => entry.action) ?? [...actions],
		]),
	);
}

/**
 * Every `harvestFetch(` the server makes, its deadline resolved (none named: core's
 * default). A call it cannot read — no inline object, a spread, a deadline that is
 * not a plain number or a module constant of one — is red, never skipped.
 */
async function harvestSites(): Promise<HarvestSite[]> {
	const byModule = await harvestActions();
	const sites: HarvestSite[] = [];
	for (const [file, source] of serverSources()) {
		const argumentsRead = callArguments(source, 'harvestFetch');
		const calls = (source.match(/\bharvestFetch\(/g) ?? []).length;
		expect(argumentsRead.length, `${file}: every harvestFetch( takes an inline object`).toBe(calls);
		for (const argument of argumentsRead) {
			expect(argument, `${file}: a harvestFetch argument without a spread`).not.toContain('...');
			// `{ timeoutMs }` is shorthand for `timeoutMs: timeoutMs`
			const key = /\btimeoutMs\b\s*(?::\s*([^,\n}]+))?/.exec(argument);
			const value = key === null ? undefined : (key[1]?.trim() ?? 'timeoutMs');
			let timeoutMs: number | null = HARVEST_DEFAULT_TIMEOUT_MS;
			if (value !== undefined) {
				const declared = /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
					? new RegExp(`const ${value} = ([^;\n]+);`).exec(source)?.[1]
					: value;
				timeoutMs = declared === undefined ? null : productMs(declared);
			}
			expect(timeoutMs, `${file}: timeoutMs ${String(value)} reads as a number`).not.toBeNull();
			sites.push({ file, actions: byModule.get(file) ?? [], timeoutMs: timeoutMs as number });
		}
	}
	return sites;
}

/** The GDAL version probe's deadline (capabilities.ts), run before every GDAL binary. */
function probeTimeoutMs(): number {
	const source = serverSources().get('capabilities.ts') ?? '';
	const match = /runBinary\(\[resolved, \.\.\.versionArgs\], \{ timeoutMs: ([0-9_]+)/.exec(source);
	expect(match, 'the probe names its deadline').not.toBeNull();
	return Number((match?.[1] ?? '').replaceAll('_', ''));
}

/**
 * The calls that wait on this server, priced: a binary run, gdal.ts's probe
 * before one, a converter slot (core's queue, at its default). Every other
 * function's price is what its body calls, so a wrapper is never free.
 */
function primitivePrices(): ReadonlyMap<string, number> {
	return new Map([
		['runToolBinary', TOOL_BINARY_TIMEOUT_MS],
		['resolveGdalBinary', probeTimeoutMs()],
		['withConverterSlot', Number(MEDIA_KEYS.DEDALO_MEDIA_CONVERT_QUEUE_SECONDS.default) * 1000],
	]);
}

/** Priced calls that sit inside a loop: each would need its own bound. */
function pricedCallsInLoops(): string[] {
	const primitives = primitivePrices();
	const { callsIn } = priceServer(serverSources(), primitives);
	const found: string[] = [];
	for (const [file, source] of serverSources()) {
		const spans = loopSpans(source);
		for (const fn of moduleFunctions(source)) {
			if (primitives.has(fn.name)) continue;
			for (const call of callsIn(file, fn)) {
				if (spans.some(([open, close]) => call.at > open && call.at < close)) {
					found.push(`${file}: ${fn.name} calls ${call.callee} in a loop`);
				}
			}
		}
	}
	return found;
}

/** The longest each action can wait on its own server: its handler's price. */
async function serverWaitByAction(): Promise<Map<string, number>> {
	const { apiActions } = await loadTool();
	const { priceOf } = priceServer(serverSources(), primitivePrices());
	const waits = new Map<string, number>();
	for (const [file, handled] of await actionsByModule()) {
		for (const { action, handler } of handled) {
			const spec = apiActions[action];
			expect(spec && unguarded(spec.handler).name).toBe(handler);
			waits.set(action, priceOf(file, handler));
		}
	}
	return waits;
}

/** A browser constant's value in ms: `NAME = 4 * 60 * 1000` (digits and `*` only). */
function browserConstantMs(file: string, name: string): number | null {
	const source = readFileSync(join(JS_DIR, file), 'utf8');
	const expression = new RegExp(`const ${name} = ([^;\\n]+);?\\n`).exec(source)?.[1];
	return expression === undefined ? null : productMs(expression);
}

/** The budget an action's calls name: a shared one, or the constant its call site names. */
function budgetMsOf(action: string): number | null {
	const shared = BUDGET_OF[action];
	if (shared !== undefined) return budgets[shared] as number;
	const named = callSites()
		.filter((site) => site.action === action && site.timeout !== null)
		.map((site) => browserConstantMs(site.file, site.timeout as string));
	if (named.length === 0 || named.includes(null)) return null;
	return Math.min(...(named as number[]));
}

describe("tool_uca_maps request budgets — outlast the server's worst case", () => {
	test("every timed call names its action's budget", () => {
		const wrong = callSites()
			.filter((site) => site.timeout !== null && site.action in BUDGET_OF)
			.filter((site) => site.timeout !== BUDGET_OF[site.action])
			.map((site) => `${site.file}: ${site.action} uses ${site.timeout}`);
		expect(wrong).toEqual([]);
		const unlisted = callSites()
			.filter((site) => /^(LOOKUP|CONVERSION|UPLOAD)_TIMEOUT_MS$/.test(String(site.timeout)))
			.filter((site) => !(site.action in BUDGET_OF))
			.map((site) => site.action);
		expect(unlisted).toEqual([]);
	});

	// a geo service counts its wait for a slot (core's limiters) and its own deadline
	test("a lookup outlasts Catastro's two calls, any one geo service, and a harvest", async () => {
		const asked = askedGeoServices();
		expect(asked).toContain('catastro_wfs_parcel');
		const call = (id: string) => {
			const service = GEO_SERVICES[id as keyof typeof GEO_SERVICES];
			return GEO_ORIGINS[service.origin].maxWaitMs + service.timeoutMs;
		};
		const catastro = call('catastro_wms_featureinfo') + call('catastro_wfs_parcel');
		const slowestOne = Math.max(...asked.map(call));
		const lookups = (await harvestSites()).filter((site) =>
			site.actions.some((action) => BUDGET_OF[action] === 'LOOKUP_TIMEOUT_MS'),
		);
		expect(lookups.length).toBeGreaterThan(0);
		const harvest = Math.max(...lookups.map((site) => harvestHopMs(site.timeoutMs)));
		const worst = Math.max(catastro, slowestOne, harvest);
		expect(budgets.LOOKUP_TIMEOUT_MS).toBeGreaterThanOrEqual(worst + ROOM_MS);
	});

	test("a lookup budget keeps data_manager's busy cue (not past its long wait)", () => {
		const source = readFileSync(
			join(import.meta.dir, '../../client/dedalo/core/common/js/data_manager.js'),
			'utf8',
		);
		const match = /export const LONG_WAIT_TIMEOUT_MS = ([0-9_]+)/.exec(source);
		expect(match).not.toBeNull();
		expect(budgets.LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(Number(match?.[1]));
	});

	test("every harvest outlasts one hop in each of its actions' budgets", async () => {
		const sites = await harvestSites();
		expect(sites.some((site) => site.actions.includes('stage_external_image'))).toBe(true);
		const short = sites.flatMap((site) =>
			site.actions.length === 0
				? [`${site.file}: no action`]
				: site.actions
						.map((action) => ({ action, budget: budgetMsOf(action) }))
						.filter(
							({ budget }) => budget === null || budget < harvestHopMs(site.timeoutMs) + ROOM_MS,
						)
						.map(({ action, budget }) => `${site.file}: ${action}, budget ${String(budget)}`),
		);
		expect(short).toEqual([]);
	});

	test('the loop scan sees every loop shape a priced call could hide in', () => {
		const planted = [
			'for (const f of files) await runToolBinary(f);',
			'for await (const f of files) { await runToolBinary(f); }',
			'while (more) { await runToolBinary(f); }',
			'do { await runToolBinary(f); } while (more);',
			'files.map((f) => runToolBinary(f));',
		];
		for (const snippet of planted) {
			const at = snippet.indexOf('runToolBinary(');
			const spans = loopSpans(snippet);
			expect(
				spans.some(([open, close]) => at > open && at < close),
				snippet,
			).toBe(true);
		}
		const loops = [...serverSources().values()].reduce(
			(sum, source) => sum + loopSpans(source).length,
			0,
		);
		expect(loops).toBeGreaterThan(0);
	});

	test('no priced call — a binary run, a probe, a converter slot or a function making one — repeats inside a loop', () => {
		expect(pricedCallsInLoops()).toEqual([]);
	});

	test('every action that waits on its server outlasts all its waits', async () => {
		const waits = await serverWaitByAction();
		expect(waits.get('upload_vector_layer') ?? 0).toBeGreaterThan(0);
		expect(waits.get('image_download') ?? 0).toBeGreaterThan(0);
		const short = [...waits]
			.filter(([, wait]) => wait > 0)
			.map(([action, wait]) => ({ action, wait, budget: budgetMsOf(action) }))
			.filter(({ wait, budget }) => budget === null || budget < wait + ROOM_MS)
			.map(
				({ action, wait, budget }) => `${action}: waits ${String(wait)}, budget ${String(budget)}`,
			);
		expect(short).toEqual([]);
	});
});
