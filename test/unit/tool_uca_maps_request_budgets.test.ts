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
import { GEO_ORIGINS, GEO_SERVICE_IDS, GEO_SERVICES } from '../../src/core/geo_services/table.ts';
import { HARVEST_DEFAULT_TIMEOUT_MS } from '../../src/core/harvest/harvest.ts';
import { INTERACTIVE_MAX_WAIT_MS } from '../../src/core/harvest/interactive_limits.ts';
import { TOOL_BINARY_TIMEOUT_MS } from '../../tools/tool_uca_maps/server/gdal.ts';
import { loadTool } from './fixtures/tool_uca_maps/helpers.ts';

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

/** The first `{…}` argument of every `<callee>(` call, brace-matched. */
function callArguments(source: string, callee = 'tool_request'): string[] {
	const found: string[] = [];
	const call = new RegExp(`\\b${callee}\\(\\s*\\{`, 'g');
	for (let match = call.exec(source); match !== null; match = call.exec(source)) {
		const open = source.indexOf('{', match.index);
		let depth = 0;
		let end = open;
		for (; end < source.length; end++) {
			if (source[end] === '{') depth++;
			else if (source[end] === '}' && --depth === 0) break;
		}
		found.push(source.slice(open, end + 1));
		call.lastIndex = end;
	}
	return found;
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
		for (const site of sites) expect(site.action).toMatch(/^[a-z_]+$/);
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

/** Server modules, keyed by file name. */
function serverSources(): Map<string, string> {
	return new Map(
		readdirSync(SERVER_DIR)
			.filter((name) => name.endsWith('.ts'))
			.map((name) => [name, readFileSync(join(SERVER_DIR, name), 'utf8')]),
	);
}

/** The actions whose handler each server module exports, read off index.ts. */
async function actionsByModule(): Promise<Map<string, string[]>> {
	const { apiActions } = await loadTool();
	const index = readFileSync(join(SERVER_DIR, 'index.ts'), 'utf8');
	const byModule = new Map<string, string[]>();
	for (const action of Object.keys(apiActions)) {
		const handler = new RegExp(`\\b${action}: \\{[^}]*\\bhandler: (\\w+)`).exec(index)?.[1];
		const from = new RegExp(`import \\{[^}]*\\b${handler}\\b[^}]*\\} from '\\./([a-z_]+\\.ts)'`);
		const file = handler === undefined ? undefined : from.exec(index)?.[1];
		expect(file, `the module of ${action}'s handler`).toBeDefined();
		byModule.set(file as string, [...(byModule.get(file as string) ?? []), action]);
	}
	return byModule;
}

/** Harvests whose client budget lives outside this census, and why. */
const OWN_HARVEST_BUDGET: Readonly<Record<string, string>> = Object.freeze({
	stage_external_image: 'a mutating action: its own budget, STAGE_EXTERNAL_IMAGE_TIMEOUT_MS',
});

interface HarvestSite {
	file: string;
	actions: string[];
	timeoutMs: number;
}

/** Tool modules a module imports (`from './x.ts'`). */
function localImports(source: string): string[] {
	return [...source.matchAll(/from '\.\/([a-z_]+\.ts)'/g)].map((m) => m[1] as string);
}

/**
 * The actions each module's harvests serve: a handler module's own actions; a helper
 * module (no handler) inherits every action whose module imports it, at any depth.
 * A handler module imported for a flag does not lend its harvests to the importer.
 */
async function harvestActions(): Promise<Map<string, string[]>> {
	const sources = serverSources();
	const reaching = new Map<string, Set<string>>();
	for (const [handlerFile, actions] of await actionsByModule()) {
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
	const own = await actionsByModule();
	return new Map([...reaching].map(([file, actions]) => [file, own.get(file) ?? [...actions]]));
}

/** Every `harvestFetch(` the server makes, its deadline resolved (none named: core's default). */
async function harvestSites(): Promise<HarvestSite[]> {
	const byModule = await harvestActions();
	const sites: HarvestSite[] = [];
	for (const [file, source] of serverSources()) {
		for (const argument of callArguments(source, 'harvestFetch')) {
			const named = /\btimeoutMs\s*:\s*([A-Za-z0-9_]+)/.exec(argument)?.[1];
			let timeoutMs = HARVEST_DEFAULT_TIMEOUT_MS;
			if (named !== undefined && /^[0-9_]+$/.test(named)) {
				timeoutMs = Number(named.replaceAll('_', ''));
			} else if (named !== undefined) {
				const declared = new RegExp(`const ${named} = ([0-9_]+);`).exec(source)?.[1];
				expect(declared, `${file}: ${named} is a number declared in the module`).toBeDefined();
				timeoutMs = Number((declared as string).replaceAll('_', ''));
			}
			sites.push({ file, actions: byModule.get(file) ?? [], timeoutMs });
		}
	}
	return sites;
}

/** A binary run: `runToolBinary(` itself, or a gdal.ts helper that makes exactly one. */
const BINARY_RUN = /\b(?:runToolBinary|readGdalInfoJson)\(/g;

/**
 * Binary runs each action can make: every run in its handler's module and in the
 * helper modules it imports (gdal.ts, where the runners live, counted at its callers;
 * another handler's module, imported for a helper, lends none — as for harvests).
 * One run per call site: a run inside a loop would need its own bound here.
 */
async function binaryRunsByAction(): Promise<Map<string, number>> {
	const sources = serverSources();
	const byModule = await actionsByModule();
	const runsOf = (file: string, seen: Set<string>): number => {
		if (seen.has(file) || file === 'gdal.ts') return 0;
		if (seen.size > 0 && byModule.has(file)) return 0;
		seen.add(file);
		const source = sources.get(file) ?? '';
		const own = (source.match(BINARY_RUN) ?? []).length;
		return own + localImports(source).reduce((sum, next) => sum + runsOf(next, seen), 0);
	};
	const runs = new Map<string, number>();
	for (const [file, actions] of byModule) {
		for (const action of actions) runs.set(action, runsOf(file, new Set()));
	}
	return runs;
}

/** A browser constant's value in ms: `NAME = 4 * 60 * 1000` (digits and `*` only). */
function browserConstantMs(file: string, name: string): number | null {
	const source = readFileSync(join(JS_DIR, file), 'utf8');
	const expression = new RegExp(`const ${name} = ([0-9_ *]+)\\n`).exec(source)?.[1];
	if (expression === undefined) return null;
	return expression
		.split('*')
		.map((factor) => Number(factor.trim().replaceAll('_', '')))
		.reduce((product, factor) => product * factor, 1);
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

	// each hop counts its wait for a slot (core's limiters) and its own deadline
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
		const harvest =
			INTERACTIVE_MAX_WAIT_MS +
			coreRobotsTimeoutMs() +
			INTERACTIVE_MAX_WAIT_MS +
			Math.max(...lookups.map((site) => site.timeoutMs));
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

	test('every harvest belongs to an action this census budgets, or names its own', async () => {
		const sites = await harvestSites();
		expect(sites.length).toBeGreaterThan(0);
		const loose = sites
			.filter((site) => !site.actions.some((a) => a in BUDGET_OF))
			.filter(
				(site) => site.actions.length === 0 || !site.actions.every((a) => a in OWN_HARVEST_BUDGET),
			)
			.map((site) => `${site.file} (${site.actions.join(', ') || 'no action'})`);
		expect(loose).toEqual([]);
	});

	test('every action that runs binaries outlasts all its runs', async () => {
		const runs = await binaryRunsByAction();
		expect(runs.get('upload_vector_layer') ?? 0).toBeGreaterThan(0);
		expect(runs.get('image_download') ?? 0).toBeGreaterThan(0);
		const short = [...runs]
			.filter(([, count]) => count > 0)
			.map(([action, count]) => ({ action, count, budget: budgetMsOf(action) }))
			.filter(
				({ count, budget }) => budget === null || budget < count * TOOL_BINARY_TIMEOUT_MS + ROOM_MS,
			)
			.map(
				({ action, count, budget }) => `${action}: ${String(count)} runs, budget ${String(budget)}`,
			);
		expect(short).toEqual([]);
	});
});
