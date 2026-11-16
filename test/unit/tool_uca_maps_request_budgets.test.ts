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
import { INTERACTIVE_MAX_WAIT_MS } from '../../src/core/harvest/interactive_limits.ts';
import { TOOL_BINARY_TIMEOUT_MS } from '../../tools/tool_uca_maps/server/gdal.ts';
import { PLEIADES_PLACE_TIMEOUT_MS } from '../../tools/tool_uca_maps/server/roman_empire.ts';
import { WMS_CAPABILITIES_TIMEOUT_MS } from '../../tools/tool_uca_maps/server/wms.ts';
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

/** The `{…}` argument of every `tool_request(` call, brace-matched. */
function callArguments(source: string): string[] {
	const found: string[] = [];
	let at = source.indexOf('tool_request({');
	while (at !== -1) {
		const open = source.indexOf('{', at);
		let depth = 0;
		let end = open;
		for (; end < source.length; end++) {
			if (source[end] === '{') depth++;
			else if (source[end] === '}' && --depth === 0) break;
		}
		found.push(source.slice(open, end + 1));
		at = source.indexOf('tool_request({', end);
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
	test("a lookup outlasts Catastro's two calls, any one geo service, and a harvest", () => {
		const asked = askedGeoServices();
		expect(asked).toContain('catastro_wfs_parcel');
		const call = (id: string) => {
			const service = GEO_SERVICES[id as keyof typeof GEO_SERVICES];
			return GEO_ORIGINS[service.origin].maxWaitMs + service.timeoutMs;
		};
		const catastro = call('catastro_wms_featureinfo') + call('catastro_wfs_parcel');
		const slowestOne = Math.max(...asked.map(call));
		const harvest =
			INTERACTIVE_MAX_WAIT_MS +
			coreRobotsTimeoutMs() +
			INTERACTIVE_MAX_WAIT_MS +
			Math.max(WMS_CAPABILITIES_TIMEOUT_MS, PLEIADES_PLACE_TIMEOUT_MS);
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

	test('a conversion outlasts two binary runs, an upload three', () => {
		expect(budgets.CONVERSION_TIMEOUT_MS).toBeGreaterThanOrEqual(
			2 * TOOL_BINARY_TIMEOUT_MS + ROOM_MS,
		);
		expect(budgets.UPLOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(3 * TOOL_BINARY_TIMEOUT_MS + ROOM_MS);
	});
});
