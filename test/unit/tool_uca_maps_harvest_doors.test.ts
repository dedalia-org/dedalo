/**
 * tool_uca_maps — the three files it fetches from other sites go through the
 * harvesting door (`harvestFetch`, engineering/OUTBOUND_SPEC.md §2-3): a WMS
 * GetCapabilities, a Pleiades place, the Pleiades dumps `provision.ts` reads.
 *
 * Each runs against a SCRIPTED site (`HarvestDeps.hop` replaces the pinned
 * primitive, the clock and the pace's sleep are ours): no network, no wait.
 * What is pinned is the tool's half of the contract — the host policy it
 * declares, what a redirect, a robots.txt, a non-2xx or an oversized body
 * turn into — not the door itself (`harvest_door_native.test.ts`). The two
 * actions are driven through the handlers the action table pins as bound.
 * Robots verdicts and the pace are process-wide: cleared around every test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DedaloError } from '../../src/core/errors/index.ts';
import type { HarvestDeps } from '../../src/core/harvest/harvest.ts';
import { clearPacingForTests } from '../../src/core/harvest/pacing.ts';
import { clearRobotsCache } from '../../src/core/harvest/robots.ts';
import type { PinnedHopRequest, PinnedHopResponse } from '../../src/core/security/ssrf_guard.ts';
import {
	PLEIADES_DUMP_MAX_BYTES,
	PLEIADES_DUMP_MAX_EXPANDED_BYTES,
	readDump,
} from '../../tools/tool_uca_maps/gazetteers/provision.ts';
import { getPleiadesPlace } from '../../tools/tool_uca_maps/server/roman_empire.ts';
import { getWmsLayers } from '../../tools/tool_uca_maps/server/wms.ts';
import { contextOf, dataOf, failureOf } from './fixtures/tool_uca_maps/helpers.ts';

interface Scripted {
	status: number;
	body?: string | Uint8Array;
	location?: string;
}

interface ScriptedSite {
	deps: HarvestDeps;
	/** Every URL the door requested, in order. */
	sent: string[];
	/** The byte ceiling each request carried, by URL. */
	ceilings: Map<string, number>;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** A site answering by URL the way the pinned primitive would. */
function scriptedSite(routes: Record<string, Scripted>): ScriptedSite {
	const sent: string[] = [];
	const ceilings = new Map<string, number>();
	let now = 1_000_000;
	const hop = async (request: PinnedHopRequest): Promise<PinnedHopResponse> => {
		const url = request.url.toString();
		sent.push(url);
		ceilings.set(url, request.maxBytes);
		const answer = routes[url] ?? { status: 404 };
		const headers = new Headers();
		const location = REDIRECTS.has(answer.status) ? (answer.location ?? null) : null;
		const base = { status: answer.status, headers, location, truncated: false };
		if (location !== null) return { ...base, bytes: new Uint8Array(0), bodySkipped: true };
		const body =
			typeof answer.body === 'string'
				? new TextEncoder().encode(answer.body)
				: (answer.body ?? new Uint8Array(0));
		if (body.byteLength > request.maxBytes) {
			throw new DedaloError('security.outbound_failed', {
				coordinates: { reason: 'body_cap', max_bytes: request.maxBytes },
			});
		}
		return { ...base, bytes: body, bodySkipped: false };
	};
	const deps: HarvestDeps = {
		hop,
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
		setTimer: () => {},
	};
	return { deps, sent, ceilings };
}

beforeEach(() => {
	clearRobotsCache();
	clearPacingForTests();
});

afterEach(() => {
	clearRobotsCache();
	clearPacingForTests();
});

const CAPABILITIES = '<WMS_Capabilities version="1.3.0"><Capability/></WMS_Capabilities>';

describe('tool_uca_maps get_wms_layers — through harvestFetch', () => {
	test('a redirect is followed, and the base returned is where the service landed', async () => {
		const site = scriptedSite({
			'http://wms.example/geoserver/wms?service=WMS&request=GetCapabilities': {
				status: 301,
				location: 'https://wms.example/geoserver/ows?service=WMS&request=GetCapabilities',
			},
			'https://wms.example/geoserver/ows?service=WMS&request=GetCapabilities': {
				status: 200,
				body: CAPABILITIES,
			},
		});
		const data = dataOf(
			await getWmsLayers(contextOf({ url: 'http://wms.example/geoserver/wms' }), site.deps),
		);
		expect(data).toEqual({ url: 'https://wms.example/geoserver/ows', xml: CAPABILITIES });
	});

	test("the site's robots.txt is obeyed: a disallowed path is never requested", async () => {
		const capabilities = 'https://wms.example/wms?service=WMS&request=GetCapabilities';
		const site = scriptedSite({
			'https://wms.example/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /wms\n' },
			[capabilities]: { status: 200, body: CAPABILITIES },
		});
		const error = await failureOf(
			getWmsLayers(contextOf({ url: 'https://wms.example/wms' }), site.deps),
		);
		expect(error.code).toBe('harvest.robots_disallowed');
		expect(site.sent).toContain('https://wms.example/robots.txt');
		expect(site.sent).not.toContain(capabilities);
	});

	test('a non-2xx answer is a plain, non-retryable failure naming the status', async () => {
		const site = scriptedSite({
			'https://wms.example/wms?service=WMS&request=GetCapabilities': { status: 404 },
		});
		const error = await failureOf(
			getWmsLayers(contextOf({ url: 'https://wms.example/wms' }), site.deps),
		);
		expect(error.code).toBe('tool.action_failed');
		expect(error.message).toContain('HTTP 404');
	});
});

describe('tool_uca_maps get_pleiades_place — through harvestFetch, Pleiades over https only', () => {
	const PLACE = 'https://pleiades.stoa.org/places/423025/json';

	test('a place document comes back parsed', async () => {
		const place = {
			type: 'FeatureCollection',
			id: '423025',
			title: 'Saguntum',
			features: [
				{
					type: 'Feature',
					properties: { title: 'Saguntum', location_precision: 'precise' },
					geometry: { type: 'Point', coordinates: [-0.2726, 39.6766] },
				},
			],
		};
		const site = scriptedSite({ [PLACE]: { status: 200, body: JSON.stringify(place) } });
		const data = dataOf(await getPleiadesPlace(contextOf({ id: '423025' }), site.deps));
		expect(data).toEqual({ place });
		expect(site.sent).toContain(PLACE);
	});

	test.each([
		['off Pleiades', 302, 'https://elsewhere.example/places/423025/json'],
		['down to http', 301, 'http://pleiades.stoa.org/places/423025/json'],
	])('a redirect %s is refused, never followed', async (_case, status, location) => {
		const site = scriptedSite({ [PLACE]: { status, location } });
		const error = await failureOf(getPleiadesPlace(contextOf({ id: '423025' }), site.deps));
		expect(error.code).toBe('harvest.refused');
		expect(site.sent).not.toContain(location);
	});

	test("Pleiades' robots.txt is obeyed: a disallowed place is never requested", async () => {
		const site = scriptedSite({
			'https://pleiades.stoa.org/robots.txt': {
				status: 200,
				body: 'User-agent: *\nDisallow: /places\n',
			},
			[PLACE]: { status: 200, body: '{"features":[]}' },
		});
		const error = await failureOf(getPleiadesPlace(contextOf({ id: '423025' }), site.deps));
		expect(error.code).toBe('harvest.robots_disallowed');
		expect(site.sent).not.toContain(PLACE);
	});

	test('an unknown id (404) is a plain failure, not a retryable transport one', async () => {
		const site = scriptedSite({ 'https://pleiades.stoa.org/places/1/json': { status: 404 } });
		const error = await failureOf(getPleiadesPlace(contextOf({ id: '1' }), site.deps));
		expect(error.code).toBe('tool.action_failed');
	});

	test('a 200 that is not a place document is refused', async () => {
		for (const body of ['not json', '{}']) {
			const site = scriptedSite({ [PLACE]: { status: 200, body } });
			const error = await failureOf(getPleiadesPlace(contextOf({ id: '423025' }), site.deps));
			expect(error.code).toBe('security.outbound_failed');
			clearPacingForTests();
		}
	});
});

describe('tool_uca_maps provision.ts — the Pleiades dumps, capped', () => {
	const DUMP = 'https://atlantides.org/downloads/pleiades/dumps/pleiades-places-latest.csv.gz';

	test('a dump is read under the declared ceiling and its [title, id] pairs extracted', async () => {
		const csv = 'title,path\nSaguntum,/places/265849\n"Carthago Nova, Hispania",/places/265968\n';
		const site = scriptedSite({ [DUMP]: { status: 200, body: Bun.gzipSync(csv) } });
		expect(await readDump(DUMP, site.deps)).toEqual([
			['Saguntum', '265849'],
			['Carthago Nova, Hispania', '265968'],
		]);
		expect(site.ceilings.get(DUMP)).toBe(PLEIADES_DUMP_MAX_BYTES);
	});

	test('the names dump points at its place through the pid column', async () => {
		const NAMES = 'https://atlantides.org/downloads/pleiades/dumps/pleiades-names-latest.csv.gz';
		const csv = 'title,pid\nArse,/places/265849\n';
		const site = scriptedSite({ [NAMES]: { status: 200, body: Bun.gzipSync(csv) } });
		expect(await readDump(NAMES, site.deps)).toEqual([['Arse', '265849']]);
	});

	test('a dump past the byte ceiling is refused, not read into memory', async () => {
		const site = scriptedSite({
			[DUMP]: { status: 200, body: new Uint8Array(PLEIADES_DUMP_MAX_BYTES + 1) },
		});
		const error = await failureOf(readDump(DUMP, site.deps));
		expect(error.code).toBe('harvest.too_large');
	});

	test('a dump that expands past its ceiling is refused, not decompressed whole', async () => {
		// concatenated gzip members: ~270 KB on the wire, 257 MiB once expanded
		const member = Bun.gzipSync(new Uint8Array(1024 * 1024));
		const members = PLEIADES_DUMP_MAX_EXPANDED_BYTES / (1024 * 1024) + 1;
		const bomb = new Uint8Array(member.byteLength * members);
		for (let i = 0; i < members; i++) bomb.set(member, i * member.byteLength);
		expect(bomb.byteLength).toBeLessThan(PLEIADES_DUMP_MAX_BYTES);

		const site = scriptedSite({ [DUMP]: { status: 200, body: bomb } });
		const error = await failureOf(readDump(DUMP, site.deps));
		expect(error.code).toBe('harvest.too_large');
		expect(error.details).toEqual({
			site: 'https://atlantides.org',
			max_bytes: PLEIADES_DUMP_MAX_EXPANDED_BYTES,
		});
	});

	test('a dump that expands past the download ceiling but within its own is read', async () => {
		// 65 MiB once expanded: refused if the expansion were capped at the 64 MiB download ceiling
		const padding = `${' '.repeat(1023)}\n`.repeat(65 * 1024);
		const csv = `title,path\nSaguntum,/places/265849\n${padding}`;
		expect(csv.length).toBeGreaterThan(PLEIADES_DUMP_MAX_BYTES);
		const site = scriptedSite({ [DUMP]: { status: 200, body: Bun.gzipSync(csv) } });
		expect(await readDump(DUMP, site.deps)).toEqual([['Saguntum', '265849']]);
	});

	test("Pleiades' robots.txt is obeyed for the dumps too", async () => {
		const site = scriptedSite({
			'https://atlantides.org/robots.txt': {
				status: 200,
				body: 'User-agent: *\nDisallow: /downloads\n',
			},
			[DUMP]: { status: 200, body: Bun.gzipSync('title,path\n') },
		});
		const error = await failureOf(readDump(DUMP, site.deps));
		expect(error.code).toBe('harvest.robots_disallowed');
		expect(site.sent).not.toContain(DUMP);
	});

	test('a dump that does not answer 2xx is a plain failure', async () => {
		const site = scriptedSite({ [DUMP]: { status: 500 } });
		const error = await failureOf(readDump(DUMP, site.deps));
		expect(error.code).toBe('tool.action_failed');
	});

	test('a dump anywhere but Pleiades over https is refused before any request', async () => {
		for (const url of [
			'https://mirror.example/pleiades.csv.gz',
			'http://atlantides.org/downloads/pleiades/dumps/pleiades-places-latest.csv.gz',
		]) {
			const site = scriptedSite({});
			const error = await failureOf(readDump(url, site.deps));
			expect(error.code).toBe('harvest.refused');
			expect(site.sent.some((sent) => sent === url)).toBe(false);
		}
	});
});
