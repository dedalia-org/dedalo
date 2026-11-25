/**
 * PUBLIC-URL PROBE (PUBLICATION_HOST_SPEC §7, phase 6; plan Decisions P1-P3).
 *
 * TIER: pure + filesystem. NO DB, NO network: every request goes through the real
 * `fetchGuardedText` (vet → pin → capped read) with its `lookup`/`fetch` seams
 * injected, so the address policy, the redirect refusal and the byte cap are the
 * production ones. The media root is a MARKED scratch root behind
 * `overrideMediaProtectionPathsForTests`; the registry/runtime files live in a
 * declared scratch base (useScratchPublicationHostsBase).
 *
 * Review Focus 4: probe paths that no longer mean what they claim (the "published"
 * file was unpublished) report `unknown` with the reason — never `ok`, and no
 * request leaves. Same for a public_url that is not a bare origin.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { widget } from '../../src/core/area_maintenance/widgets/publication_hosts.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { formatErrorLine } from '../../src/core/errors/log.ts';
import { overrideMediaProtectionPathsForTests } from '../../src/core/media/protection.ts';
import {
	attachProbe,
	DECORATOR_CHECK_IDS,
	type HostPanelRow,
	PUBLIC_GATE_CHECK_ID,
	publicGateCheck,
} from '../../src/core/publication_host/host_status.ts';
import {
	agentCopyHolding,
	BARE_ORIGIN_REFUSAL,
	bareOrigin,
	type CopyHolding,
	copyBatchChanged,
	httpsUpgradeOf,
	NEVER_PROBED,
	PROBE_MAX_AGE_MS,
	type ProbeDeps,
	PUBLICATION_PROBE_EVERY_MS,
	PUBLICATION_PROBE_RECONCILE,
	probeAfterRulesApplied,
	probeHostRecord,
	probePublicGate,
	scheduleProbeAfterChange,
	scheduleProbeAfterCopyBatch,
	validateProbePaths,
} from '../../src/core/publication_host/probe.ts';
import {
	type PublicationHostRecord,
	saveRegistry,
} from '../../src/core/publication_host/registry.ts';
import { loadRuntime, updateHostRuntime } from '../../src/core/publication_host/runtime.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import {
	fetchGuardedText,
	type PinnedFetchInit,
	refusedRedirectLocation,
} from '../../src/core/security/ssrf_guard.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';
import { useScratchPublicationHostsBase } from '../helpers/publication_host_fixtures.ts';
import { stripComments } from '../helpers/strip_comments.ts';

const QUALITY = 'image/1.5MB';
const PUB_FILE = 'test99_test3_1.jpg';
const UNPUB_FILE = 'test99_test3_2.jpg';
const PUB_PATH = `${QUALITY}/0/${PUB_FILE}`;
const UNPUB_PATH = `${QUALITY}/0/${UNPUB_FILE}`;
/** A public (non-reserved) address the injected resolver answers with; the injected fetch never dials it. */
const PUBLIC_IP = '93.184.215.14';

function record(overrides: Partial<PublicationHostRecord> = {}): PublicationHostRecord {
	return {
		name: 'probe_host',
		instance: 'test',
		fingerprint: 'a'.repeat(64),
		address: { kind: 'unix', socket: '/tmp/dedalo_probe_host_absent.sock' },
		public_url: 'https://www.museum.test',
		qualities: [QUALITY],
		probe: { published: PUB_PATH, unpublished: UNPUB_PATH },
		paired_at: '2026-10-03T00:00:00.000Z',
		...overrides,
	};
}

type Answer = (init: PinnedFetchInit, url: URL) => Response;
interface Seen {
	path: string;
	search: string;
	range: string | null;
	/** The scheme and port the pinned request went out on, and the Host it kept. */
	protocol: string;
	port: string;
	host: string | null;
}

/**
 * The guard seams + the agent's copy answer. Default `not_copy` (a shared host: the files
 * are the work tree's); the COPY HOSTS legs pass their own.
 */
function fakeDeps(
	answers: Record<string, Answer>,
	seen: Seen[] = [],
	address: string = PUBLIC_IP,
	holding: CopyHolding = 'not_copy',
): ProbeDeps {
	return {
		copyHolding: async () => holding,
		lookup: async () => [{ address, family: 4 }],
		fetch: async (url: string, init: PinnedFetchInit) => {
			const parsed = new URL(url);
			const { pathname, search } = parsed;
			const headers = new Headers(init.headers);
			seen.push({
				path: pathname,
				search,
				range: headers.get('range'),
				protocol: parsed.protocol,
				port: parsed.port,
				host: headers.get('host'),
			});
			const answer = answers[pathname.slice(pathname.lastIndexOf('/') + 1)];
			if (answer === undefined) throw new Error(`unexpected probe request ${url}`);
			return answer(init, parsed);
		},
	};
}

const partial: Answer = () => new Response('x', { status: 206 });
const notFound: Answer = () => new Response('not found', { status: 404 });
const servedWhole: Answer = () => new Response('x'.repeat(4096), { status: 200 });
const reset: Answer = () => {
	throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
};

function reasonOf(verdict: { ok: true } | { ok: false; reason: string }): string {
	return verdict.ok ? '' : verdict.reason;
}

let scratch: string;
let media: string;
let hostsBase: { base: string; dispose: () => void };

function plantMedia(relative: string): void {
	const absolute = join(media, relative);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, 'bytes');
}

function plantMarker(key: string): void {
	mkdirSync(join(media, '.publication', 'pub'), { recursive: true });
	writeFileSync(join(media, '.publication', 'pub', key), '');
}

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), 'dedalo_pubhost_probe_'));
	media = markMediaRoot(join(scratch, 'media'));
	overrideMediaProtectionPathsForTests({
		mediaRoot: media,
		authStorePath: join(scratch, 'media_auth.json'),
	});
	hostsBase = useScratchPublicationHostsBase();
	plantMedia(PUB_PATH);
	plantMedia(UNPUB_PATH);
	plantMarker('test3_1');
});

afterEach(() => {
	overrideMediaProtectionPathsForTests(null);
	hostsBase.dispose();
	rmSync(scratch, { recursive: true, force: true });
});

describe('validateProbePaths (P1): the paths must mean what they claim', () => {
	test('a published + an unpublished file in a public quality validate', async () => {
		expect(await validateProbePaths(record())).toEqual({ ok: true });
	});

	test('unset or identical paths are refused', async () => {
		const unset = await validateProbePaths(
			record({ probe: { published: null, unpublished: UNPUB_PATH } }),
		);
		expect(unset).toEqual({ ok: false, reason: 'probe paths are not set' });
		const same = await validateProbePaths(
			record({ probe: { published: PUB_PATH, unpublished: PUB_PATH } }),
		);
		expect(same.ok).toBe(false);
		expect(reasonOf(same)).toContain('same file');
	});

	test('a master quality is never probed, even when the record lists it', async () => {
		plantMedia(`image/original/0/${PUB_FILE}`);
		const verdict = await validateProbePaths(
			record({
				qualities: [QUALITY, 'image/original'],
				probe: { published: `image/original/0/${PUB_FILE}`, unpublished: UNPUB_PATH },
			}),
		);
		expect(verdict.ok).toBe(false);
		expect(reasonOf(verdict)).toContain('not under a public quality');
	});

	test('traversal, dot segments and the marker store are not plain media paths', async () => {
		for (const path of [
			'../media/x_test3_1.jpg',
			'.publication/pub/test3_1',
			`${QUALITY}//${PUB_FILE}`,
		]) {
			const verdict = await validateProbePaths(
				record({ probe: { published: path, unpublished: UNPUB_PATH } }),
			);
			expect(verdict.ok, path).toBe(false);
			expect(reasonOf(verdict), path).toContain('not a plain relative media path');
		}
	});

	test('a working file and a name outside the grammar are refused', async () => {
		const working = await validateProbePaths(
			record({
				probe: { published: `${QUALITY}/0/test99_test3_1.deleted`, unpublished: UNPUB_PATH },
			}),
		);
		expect(reasonOf(working)).toContain('working file');
		const ungrammatical = await validateProbePaths(
			record({ probe: { published: `${QUALITY}/0/photo.jpg`, unpublished: UNPUB_PATH } }),
		);
		expect(reasonOf(ungrammatical)).toContain('filename grammar');
	});

	test('a path with no file in the work media tree is refused (a 404 from absence proves nothing)', async () => {
		const verdict = await validateProbePaths(
			record({ probe: { published: PUB_PATH, unpublished: `${QUALITY}/0/test99_test3_7.jpg` } }),
		);
		expect(reasonOf(verdict)).toContain('is not a file in the work media tree');
	});

	test('REVIEW FOCUS 4: the "published" file was unpublished → refused with the reason', async () => {
		rmSync(join(media, '.publication', 'pub', 'test3_1'));
		const verdict = await validateProbePaths(record());
		expect(verdict.ok).toBe(false);
		expect(reasonOf(verdict)).toContain('is not published (no pub/test3_1 marker)');
	});

	test('the "unpublished" file was published → refused with the reason', async () => {
		plantMarker('test3_2');
		const verdict = await validateProbePaths(record());
		expect(reasonOf(verdict)).toContain('is published (pub/test3_2 exists)');
	});
});

describe('bareOrigin: the public URL is an origin, nothing else', () => {
	test('an http(s) origin, with or without a trailing slash or a port, is its origin', () => {
		expect(bareOrigin('https://www.museum.test')).toBe('https://www.museum.test');
		expect(bareOrigin('https://www.museum.test/')).toBe('https://www.museum.test');
		expect(bareOrigin('http://www.museum.test:8080')).toBe('http://www.museum.test:8080');
	});

	test('a path, query, fragment, credentials, another scheme or garbage is refused', () => {
		for (const url of [
			'https://www.museum.test/x',
			'https://www.museum.test/?y=1',
			'https://www.museum.test/#f',
			'https://u:p@www.museum.test',
			'https://u@www.museum.test',
			'ftp://www.museum.test',
			'not a url',
		]) {
			expect(bareOrigin(url), url).toBeNull();
		}
	});
});

describe('probeHostRecord (P2): through the PUBLIC door, as the public sees it', () => {
	test('published 2xx + unpublished 404 → ok; Range sent; the URL is <origin>/dedalo/<mediaDir>/<path>', async () => {
		const seen: Seen[] = [];
		const probe = await probeHostRecord(
			record(),
			fakeDeps({ [PUB_FILE]: partial, [UNPUB_FILE]: notFound }, seen),
		);
		expect(probe.state).toBe('ok');
		expect(probe.published_status).toBe(200);
		expect(probe.unpublished_status).toBe(404);
		expect(probe.detail).toBeNull();
		expect(typeof probe.at).toBe('string');
		expect(seen.map((s) => s.path)).toEqual([
			`/dedalo/${config.mediaDir}/${PUB_PATH}`,
			`/dedalo/${config.mediaDir}/${UNPUB_PATH}`,
		]);
		expect(seen.every((s) => s.range === 'bytes=0-0' && s.search === '')).toBe(true);
	});

	test('a trailing slash on the public URL changes nothing (the URL is built from url.origin)', async () => {
		const seen: Seen[] = [];
		const probe = await probeHostRecord(
			record({ public_url: 'https://www.museum.test/' }),
			fakeDeps({ [PUB_FILE]: partial, [UNPUB_FILE]: notFound }, seen),
		);
		expect(probe.state).toBe('ok');
		expect(seen[0]?.path).toBe(`/dedalo/${config.mediaDir}/${PUB_PATH}`);
	});

	test('a public_url that is not a bare origin → unknown, nothing sent (no credentials reach the door)', async () => {
		for (const url of [
			'https://www.museum.test/x',
			'https://www.museum.test/?y=1',
			'https://www.museum.test/#f',
			'https://u:p@www.museum.test',
			'not a url',
		]) {
			const seen: Seen[] = [];
			const probe = await probeHostRecord(
				record({ public_url: url }),
				fakeDeps({ [PUB_FILE]: partial, [UNPUB_FILE]: notFound }, seen),
			);
			expect(probe.state, url).toBe('unknown');
			expect(probe.detail, url).toBe(BARE_ORIGIN_REFUSAL);
			expect(seen, url).toEqual([]);
		}
	});

	test('a server that ignores Range (whole 2xx body over the cap) still counts as served', async () => {
		const probe = await probeHostRecord(
			record(),
			fakeDeps({ [PUB_FILE]: servedWhole, [UNPUB_FILE]: notFound }),
		);
		expect(probe.state).toBe('ok');
		expect(probe.published_status).toBe(200);
	});

	test('the unpublished file served → failed, the gate is OPEN', async () => {
		const probe = await probeHostRecord(
			record(),
			fakeDeps({ [PUB_FILE]: partial, [UNPUB_FILE]: partial }),
		);
		expect(probe.state).toBe('failed');
		expect(probe.unpublished_status).toBe(200);
		expect(probe.detail).toContain('the gate is OPEN');
	});

	test('an open gate is failed even when the published side is unknown', async () => {
		const probe = await probeHostRecord(
			record(),
			fakeDeps({ [PUB_FILE]: reset, [UNPUB_FILE]: partial }),
		);
		expect(probe.state).toBe('failed');
		expect(probe.published_status).toBeNull();
		expect(probe.detail).toContain('the gate is OPEN');
		expect(probe.detail).toContain('published: the public URL did not answer');
	});

	test('the published file 404 → failed', async () => {
		const probe = await probeHostRecord(
			record(),
			fakeDeps({ [PUB_FILE]: notFound, [UNPUB_FILE]: notFound }),
		);
		expect(probe.state).toBe('failed');
		expect(probe.published_status).toBe(404);
		expect(probe.detail).toContain('the published file answered HTTP 404');
	});

	test('a redirect is an answer, not a pass: failed with the 3xx status', async () => {
		const redirect: Answer = () =>
			new Response(null, { status: 302, headers: { location: 'https://login.museum.test/' } });
		const probe = await probeHostRecord(
			record(),
			fakeDeps({ [PUB_FILE]: partial, [UNPUB_FILE]: redirect }),
		);
		expect(probe.state).toBe('failed');
		expect(probe.unpublished_status).toBe(302);
	});

	test('a public_url that IS a private address → unknown: private address, nothing sent', async () => {
		const seen: Seen[] = [];
		const probe = await probeHostRecord(
			record({ public_url: 'https://127.0.0.1' }),
			fakeDeps({ [PUB_FILE]: partial, [UNPUB_FILE]: notFound }, seen),
		);
		expect(probe.state).toBe('unknown');
		expect(probe.detail).toContain('private address');
		expect(seen).toEqual([]);
	});

	test('a public_url that RESOLVES to a private address → unknown: private address, nothing sent', async () => {
		const seen: Seen[] = [];
		const probe = await probeHostRecord(
			record(),
			fakeDeps({ [PUB_FILE]: partial, [UNPUB_FILE]: notFound }, seen, '10.0.0.5'),
		);
		expect(probe.state).toBe('unknown');
		expect(probe.detail).toContain('private address');
		expect(seen).toEqual([]);
	});

	test('an unreachable host → unknown, never ok', async () => {
		const probe = await probeHostRecord(
			record(),
			fakeDeps({ [PUB_FILE]: reset, [UNPUB_FILE]: reset }),
		);
		expect(probe.state).toBe('unknown');
		expect(probe.detail).toContain('did not answer');
	});

	test('REVIEW FOCUS 4: invalid paths → unknown with the reason, and no request leaves', async () => {
		rmSync(join(media, '.publication', 'pub', 'test3_1'));
		const seen: Seen[] = [];
		const probe = await probeHostRecord(
			record(),
			fakeDeps({ [PUB_FILE]: partial, [UNPUB_FILE]: notFound }, seen),
		);
		expect(probe.state).toBe('unknown');
		expect(probe.detail).toContain('is not published');
		expect(seen).toEqual([]);
	});

	test('no public_url → unknown, nothing sent', async () => {
		const probe = await probeHostRecord(record({ public_url: null }), fakeDeps({}));
		expect(probe).toMatchObject({ state: 'unknown', detail: 'the public URL is not set' });
	});
});

describe('THE ONE REDIRECT FOLLOWED: an http → https upgrade of the same URL (§7)', () => {
	const HTTP_URL = 'http://www.museum.test';
	const mediaPath = (path: string): string => `/dedalo/${config.mediaDir}/${path}`;
	/** A 3xx whose Location the test builds from the request's own path. */
	const redirectTo =
		(status: number, target: (path: string) => string): Answer =>
		(_init, url) =>
			new Response(null, { status, headers: { location: target(url.pathname) } });
	/** Over https: `then`; over http: a 301 to the https twin (what a :80 → :443 site does). */
	const upgrading =
		(then: Answer): Answer =>
		(init, url) =>
			url.protocol === 'http:'
				? new Response(null, {
						status: 301,
						headers: { location: `https://www.museum.test${url.pathname}` },
					})
				: then(init, url);

	test('301 http → https same host: followed ONCE, through the guard again; ok with the note', async () => {
		const seen: Seen[] = [];
		const probe = await probeHostRecord(
			record({ public_url: HTTP_URL }),
			fakeDeps({ [PUB_FILE]: upgrading(partial), [UNPUB_FILE]: upgrading(notFound) }, seen),
		);
		expect(probe.state).toBe('ok');
		expect(probe.published_status).toBe(200);
		expect(probe.unpublished_status).toBe(404);
		expect(probe.detail).toBe(
			'http redirects to https — set the public URL to https://www.museum.test',
		);
		// Two requests per side, the second on https:443 — PINNED to the vetted address
		// (the injected fetch sees the IP, the real name kept as Host), Range kept.
		expect(seen.map((s) => [s.protocol, s.port, s.path])).toEqual([
			['http:', '', mediaPath(PUB_PATH)],
			['https:', '', mediaPath(PUB_PATH)],
			['http:', '', mediaPath(UNPUB_PATH)],
			['https:', '', mediaPath(UNPUB_PATH)],
		]);
		expect(seen.every((s) => s.host === 'www.museum.test' && s.range === 'bytes=0-0')).toBe(true);
	});

	test('an explicit http port upgrades to the https DEFAULT port; an explicit https port is refused', async () => {
		const toDefault = await probeHostRecord(
			record({ public_url: 'http://www.museum.test:8080' }),
			fakeDeps({ [PUB_FILE]: upgrading(partial), [UNPUB_FILE]: upgrading(notFound) }),
		);
		expect(toDefault.state).toBe('ok');
		expect(toDefault.detail).toContain('set the public URL to https://www.museum.test');

		const seen: Seen[] = [];
		const toPort = await probeHostRecord(
			record({ public_url: HTTP_URL }),
			fakeDeps(
				{
					[PUB_FILE]: redirectTo(301, (path) => `https://www.museum.test:8443${path}`),
					[UNPUB_FILE]: notFound,
				},
				seen,
			),
		);
		expect(toPort.state).toBe('failed');
		expect(toPort.published_status).toBe(301);
		expect(toPort.detail).toContain('redirected to https://www.museum.test:8443/');
		expect(seen.filter((s) => s.path === mediaPath(PUB_PATH))).toHaveLength(1);
	});

	test('301 to ANOTHER host is refused, never followed: failed, the detail says where it pointed', async () => {
		const seen: Seen[] = [];
		const probe = await probeHostRecord(
			record({ public_url: HTTP_URL }),
			fakeDeps(
				{
					[PUB_FILE]: redirectTo(301, (path) => `https://cdn.museum.test${path}`),
					[UNPUB_FILE]: notFound,
				},
				seen,
			),
		);
		expect(probe.state).toBe('failed');
		expect(probe.published_status).toBe(301);
		expect(probe.detail).toContain(
			`the published file answered HTTP 301 (must be 2xx): redirected to https://cdn.museum.test${mediaPath(PUB_PATH)}, not followed`,
		);
		expect(probe.detail).not.toContain('set the public URL');
		expect(seen.map((s) => s.protocol)).toEqual(['http:', 'http:']);
	});

	test('302 chain of two (http → https twin → elsewhere) is refused: no second hop', async () => {
		const seen: Seen[] = [];
		const secondRedirect = redirectTo(302, () => 'https://www.museum.test/login');
		const probe = await probeHostRecord(
			record({ public_url: HTTP_URL }),
			fakeDeps({ [PUB_FILE]: upgrading(secondRedirect), [UNPUB_FILE]: upgrading(notFound) }, seen),
		);
		expect(probe.state).toBe('failed');
		expect(probe.published_status).toBe(302);
		expect(probe.detail).toContain(
			'after the http → https upgrade, a second redirect: redirected to https://www.museum.test/login, not followed',
		);
		// The upgrade WAS followed, so the note is still given.
		expect(probe.detail).toContain('set the public URL to https://www.museum.test');
		expect(seen.filter((s) => s.path === mediaPath(PUB_PATH)).map((s) => s.protocol)).toEqual([
			'http:',
			'https:',
		]);
		expect(seen.some((s) => s.path === '/login')).toBe(false);
	});

	test('a redirect from the https twin back to ITSELF is not a second upgrade either', async () => {
		const loop = redirectTo(302, (path) => `https://www.museum.test${path}`);
		const seen: Seen[] = [];
		const probe = await probeHostRecord(
			record({ public_url: HTTP_URL }),
			fakeDeps({ [PUB_FILE]: upgrading(loop), [UNPUB_FILE]: upgrading(notFound) }, seen),
		);
		expect(probe.state).toBe('failed');
		expect(seen.filter((s) => s.path === mediaPath(PUB_PATH))).toHaveLength(2);
	});

	test('https → http DOWNGRADE is refused: failed, the detail names the http target', async () => {
		const seen: Seen[] = [];
		const probe = await probeHostRecord(
			record(),
			fakeDeps(
				{
					[PUB_FILE]: redirectTo(301, (path) => `http://www.museum.test${path}`),
					[UNPUB_FILE]: notFound,
				},
				seen,
			),
		);
		expect(probe.state).toBe('failed');
		expect(probe.published_status).toBe(301);
		expect(probe.detail).toContain(`redirected to http://www.museum.test${mediaPath(PUB_PATH)}`);
		expect(seen.map((s) => s.protocol)).toEqual(['https:', 'https:']);
	});

	test('the upgraded URL is RE-VETTED: an https twin resolving private is unknown, never a pass', async () => {
		let lookups = 0;
		const deps: ProbeDeps = {
			...fakeDeps({ [PUB_FILE]: upgrading(partial), [UNPUB_FILE]: upgrading(notFound) }),
			// The first answer is public, every later one private (a rebinding resolver).
			lookup: async () => {
				lookups++;
				return [{ address: lookups === 1 ? PUBLIC_IP : '10.0.0.5', family: 4 }];
			},
		};
		const probe = await probeHostRecord(record({ public_url: HTTP_URL }), deps);
		expect(probe.state).toBe('unknown');
		expect(probe.detail).toContain('published: not a public host');
		expect(probe.detail).toContain('set the public URL to https://www.museum.test');
		expect(lookups).toBeGreaterThanOrEqual(2);
	});

	test("a refused redirect's target is shown without credentials", async () => {
		const probe = await probeHostRecord(
			record({ public_url: HTTP_URL }),
			fakeDeps({
				[PUB_FILE]: redirectTo(301, (path) => `https://user:secret@www.museum.test${path}`),
				[UNPUB_FILE]: notFound,
			}),
		);
		expect(probe.state).toBe('failed');
		expect(probe.detail).toContain(`redirected to https://www.museum.test${mediaPath(PUB_PATH)}`);
		expect(probe.detail).not.toContain('secret');
	});

	test('httpsUpgradeOf: only the exact https twin of the requested URL, built from the REQUEST', () => {
		const asked = 'http://www.museum.test/dedalo/media/a%20b.jpg';
		const twin = 'https://www.museum.test/dedalo/media/a%20b.jpg';
		for (const [location, expected] of [
			[twin, twin],
			['https://WWW.Museum.test:443/dedalo/media/a%20b.jpg', twin],
			['https://www.museum.test/dedalo/media/a b.jpg', twin],
			['https://www.museum.test/dedalo/media/other.jpg', null],
			['https://www.museum.test/dedalo/media/a%20b.jpg?x=1', null],
			['https://www.museum.test/dedalo/media/a%20b.jpg#f', null],
			['https://u:p@www.museum.test/dedalo/media/a%20b.jpg', null],
			['https://evil.test/dedalo/media/a%20b.jpg', null],
			['https://www.museum.test.evil.test/dedalo/media/a%20b.jpg', null],
			['https://www.museum.test:8443/dedalo/media/a%20b.jpg', null],
			['http://www.museum.test/dedalo/media/a%20b.jpg', null],
			['/dedalo/media/a%20b.jpg', null],
			['//www.museum.test/dedalo/media/a%20b.jpg', null],
			['ftp://www.museum.test/dedalo/media/a%20b.jpg', null],
			['https://[::1', null],
			['', null],
		] as const) {
			expect(httpsUpgradeOf(asked, location), location).toBe(expected);
		}
		// An https request is never "upgraded" (nothing to upgrade; a hop to itself is a loop).
		expect(httpsUpgradeOf(twin, twin)).toBeNull();
		// An explicit http port upgrades to the https default port.
		expect(
			httpsUpgradeOf('http://www.museum.test:8080/x.jpg', 'https://www.museum.test/x.jpg'),
		).toBe('https://www.museum.test/x.jpg');
		// The returned URL is the REQUEST's twin: a query the request carried is kept as sent.
		expect(httpsUpgradeOf('http://h.test/x?a=1', 'https://h.test/x?a=1')).toBe(
			'https://h.test/x?a=1',
		);
	});

	test("the peer's Location never reaches the log line: no forged k=v, no signed query (log injection)", async () => {
		// A header value may carry spaces: printed raw as a coordinate it would FORGE pairs
		// (`formatErrorLine` joins ` k=v` unescaped), and a presigned redirect would write its
		// signature into the operator's log. The raw Location rides the error's own field.
		const hostile = '/x reason=timeout status=200 job=forged?X-Amz-Signature=secret';
		const deps = fakeDeps({ [PUB_FILE]: redirectTo(302, () => hostile) });
		let caught: unknown;
		try {
			await fetchGuardedText(`https://www.museum.test${mediaPath(PUB_PATH)}`, {}, deps);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(DedaloError);
		const line = formatErrorLine(caught as DedaloError);
		expect(line).toBe('[security] security.outbound_failed reason=redirect status=302');
		expect(refusedRedirectLocation(caught), 'the caller that asks still gets it raw').toBe(hostile);
		// Any other failure carries none.
		expect(refusedRedirectLocation(new DedaloError('security.outbound_failed'))).toBeNull();
		// And the probe's detail (operator-facing) shows it resolved and display-safe.
		const probe = await probeHostRecord(
			record(),
			fakeDeps({ [PUB_FILE]: redirectTo(302, () => hostile), [UNPUB_FILE]: notFound }),
		);
		expect(probe.state).toBe('failed');
		expect(probe.detail).toContain('redirected to https://www.museum.test/x%20reason=timeout');
		expect(probe.detail).not.toContain(' reason=timeout');
	});
});

describe("COPY HOSTS: a 404 must be the gate's, never absence's (§7)", () => {
	test('a copy host that does not hold the unpublished file → unknown with the reason, NEVER ok', async () => {
		const probe = await probeHostRecord(
			record(),
			fakeDeps({ [PUB_FILE]: partial, [UNPUB_FILE]: notFound }, [], PUBLIC_IP, 'not_held'),
		);
		expect(probe.state).toBe('unknown');
		expect(probe.detail).toContain('does not hold the unpublished probe file');
		expect(probe.detail).toContain('proves absence, not the gate');
	});

	test('a copy host whose manifest lists it (a pending deletion) → the 404 proves the gate: ok', async () => {
		const probe = await probeHostRecord(
			record(),
			fakeDeps({ [PUB_FILE]: partial, [UNPUB_FILE]: notFound }, [], PUBLIC_IP, 'held'),
		);
		expect(probe.state).toBe('ok');
		expect(probe.unpublished_status).toBe(404);
	});

	test('an agent that cannot tell → unknown; a 2xx is the gate OPEN whatever the agent holds', async () => {
		const asked = await probeHostRecord(
			record(),
			fakeDeps({ [PUB_FILE]: partial, [UNPUB_FILE]: notFound }, [], PUBLIC_IP, {
				unknown: 'agent down (test)',
			}),
		);
		expect(asked.state).toBe('unknown');
		expect(asked.detail).toContain('agent down (test)');
		const open = await probeHostRecord(
			record(),
			fakeDeps({ [PUB_FILE]: partial, [UNPUB_FILE]: partial }, [], PUBLIC_IP, 'not_held'),
		);
		expect(open.state).toBe('failed');
		expect(open.detail).toContain('the gate is OPEN');
	});

	test('the PRODUCTION answer: unreachable agent + no proven n/a → unknown; a stamped n/a → not_copy', async () => {
		saveRegistry({ version: 1, hosts: [record()] });
		expect(await agentCopyHolding(record(), UNPUB_PATH)).toEqual({
			unknown: 'the agent could not be asked whether it copies media',
		});
		const probe = await probeHostRecord(record(), {
			...fakeDeps({ [PUB_FILE]: partial, [UNPUB_FILE]: notFound }),
			copyHolding: undefined,
		});
		expect(probe.state).toBe('unknown');
		await updateHostRuntime('probe_host', (cur) => ({
			...cur,
			media_copy: { ...cur.media_copy, state: 'n/a', last_verified_at: new Date().toISOString() },
		}));
		expect(await agentCopyHolding(record(), UNPUB_PATH)).toBe('not_copy');
	});
});

describe('probePublicGate / probeAfterRulesApplied: the runtime record', () => {
	test('the verdict is written to runtime.probe', async () => {
		saveRegistry({ version: 1, hosts: [record()] });
		const probe = await probePublicGate(
			'probe_host',
			fakeDeps({ [PUB_FILE]: partial, [UNPUB_FILE]: notFound }),
		);
		expect(probe.state).toBe('ok');
		expect((await loadRuntime()).probe_host?.probe).toEqual(probe);
	});

	test('an unknown host is publication_host.unconfigured; the after-apply form never throws', async () => {
		saveRegistry({ version: 1, hosts: [] });
		await expect(probePublicGate('nope_host')).rejects.toMatchObject({
			code: 'publication_host.unconfigured',
		});
		const after = await probeAfterRulesApplied('nope_host');
		expect(after.state).toBe('unknown');
		expect(after.detail).toContain('could not run');
		expect(await loadRuntime()).toEqual({});
	});
});

describe('scheduleProbeAfterChange (P3): detached, serialized, coalesced per host', () => {
	test('a change during an in-flight probe queues ONE follow-up; further changes join it', async () => {
		let runs = 0;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runner = async (): Promise<unknown> => {
			runs++;
			await gate;
			return NEVER_PROBED;
		};
		const first = scheduleProbeAfterChange('probe_host', 'copy_batch', runner);
		await Bun.sleep(1);
		expect(runs).toBe(1);
		const second = scheduleProbeAfterChange('probe_host', 'copy_batch', runner);
		const third = scheduleProbeAfterChange('probe_host', 'copy_batch', runner);
		expect(third).toBe(second);
		expect(second).not.toBe(first);
		release();
		await Promise.all([first, second, third]);
		expect(runs).toBe(2);
	});

	test('a throwing probe never rejects the lane', async () => {
		await expect(
			scheduleProbeAfterChange('probe_host', 'apply_rules', async () => {
				throw new Error('boom');
			}),
		).resolves.toBeUndefined();
	});

	test('scheduleProbeAfterCopyBatch: a round that changed nothing schedules nothing; any change schedules one', async () => {
		let runs = 0;
		const runner = async (): Promise<unknown> => {
			runs++;
			return NEVER_PROBED;
		};
		const nothing = { put: 0, deleted: 0, withdrawn: 0, published: 0 };
		expect(copyBatchChanged(nothing)).toBe(false);
		expect(scheduleProbeAfterCopyBatch('probe_host', nothing, runner)).toBeNull();
		for (const changed of [
			{ ...nothing, put: 1 },
			{ ...nothing, deleted: 1 },
			{ ...nothing, withdrawn: 1 },
			{ ...nothing, published: 1 },
		]) {
			expect(copyBatchChanged(changed)).toBe(true);
			await scheduleProbeAfterCopyBatch('probe_host', changed, runner);
		}
		expect(runs).toBe(4);
	});
});

describe('PUBLICATION_PROBE_RECONCILE: scheduled; dry writes nothing, apply records the observation', () => {
	test('interval + autoApply with its reason, owner-sourced; drift = configured hosts not ok; dry writes nothing; apply records every host', async () => {
		expect(PUBLICATION_PROBE_RECONCILE.name).toBe('publication_probe');
		expect(PUBLICATION_PROBE_RECONCILE.schedule).toEqual({ everyMs: PUBLICATION_PROBE_EVERY_MS });
		expect(PUBLICATION_PROBE_RECONCILE.autoApply?.reason.length ?? 0).toBeGreaterThan(40);
		expect(PUBLICATION_PROBE_RECONCILE.sources).toContain('src/core/publication_host/probe.ts');
		saveRegistry({
			version: 1,
			hosts: [
				record({ name: 'probe_private', public_url: 'https://127.0.0.1' }),
				record({
					name: 'probe_unset',
					fingerprint: 'c'.repeat(64),
					address: { kind: 'unix', socket: '/tmp/dedalo_probe_unset_absent.sock' },
					public_url: null,
				}),
			],
		});
		const dry = await PUBLICATION_PROBE_RECONCILE.run({ apply: false });
		expect(dry).toEqual({
			drift: 1,
			applied: 0,
			detail: { hosts: { probe_private: 'unknown' }, skipped: ['probe_unset'], recorded: 0 },
		});
		// ReconcileRunOptions: a dry run reports drift and writes NOTHING.
		expect(await loadRuntime()).toEqual({});

		const applied = await PUBLICATION_PROBE_RECONCILE.run({ apply: true });
		// An observation repairs nothing: applied stays 0; recorded counts the runtime writes.
		expect(applied).toEqual({ ...dry, detail: { ...dry.detail, recorded: 2 } });
		const runtime = await loadRuntime();
		expect(runtime.probe_private?.probe.state).toBe('unknown');
		expect(runtime.probe_unset?.probe.detail).toBe('the public URL is not set');

		const scoped = await PUBLICATION_PROBE_RECONCILE.run({ apply: false, scope: ['probe_unset'] });
		expect(scoped.drift).toBe(0);
	});
});

describe('publicGateCheck / attachProbe (pure panel rows; detail is a FACT, never a sentence)', () => {
	const NOW = Date.parse('2026-10-03T12:00:00.000Z');
	const fresh = {
		state: 'ok' as const,
		at: '2026-10-03T11:55:00.000Z',
		published_status: 200,
		unpublished_status: 404,
		detail: null,
	};

	test('public_gate is a decorator check id (its client label is gated)', () => {
		expect(DECORATOR_CHECK_IDS).toContain(PUBLIC_GATE_CHECK_ID);
	});

	test('ok fresh → ok; ok stale → warn; failed → blocked; unknown / never → unknown', () => {
		expect(publicGateCheck(fresh, NOW, PROBE_MAX_AGE_MS)).toEqual({
			id: PUBLIC_GATE_CHECK_ID,
			state: 'ok',
			detail: 'published:200 unpublished:404',
		});
		expect(
			publicGateCheck({ ...fresh, at: '2026-10-02T00:00:00.000Z' }, NOW, PROBE_MAX_AGE_MS),
		).toEqual({
			id: PUBLIC_GATE_CHECK_ID,
			state: 'warn',
			detail: 'stale:2026-10-02T00:00:00.000Z',
		});
		expect(publicGateCheck({ ...fresh, at: 'not a date' }, NOW, PROBE_MAX_AGE_MS).state).toBe(
			'warn',
		);
		const failed = publicGateCheck(
			{ ...fresh, state: 'failed', unpublished_status: 200, detail: 'the gate is OPEN' },
			NOW,
			PROBE_MAX_AGE_MS,
		);
		expect(failed).toEqual({
			id: PUBLIC_GATE_CHECK_ID,
			state: 'blocked',
			detail: 'published:200 unpublished:200',
		});
		expect(
			publicGateCheck(
				{ ...fresh, state: 'failed', published_status: null, unpublished_status: 200 },
				NOW,
				PROBE_MAX_AGE_MS,
			).detail,
		).toBe('published:none unpublished:200');
		expect(publicGateCheck({ ...NEVER_PROBED }, NOW, PROBE_MAX_AGE_MS)).toEqual({
			id: PUBLIC_GATE_CHECK_ID,
			state: 'unknown',
			detail: 'never_probed',
		});
		expect(
			publicGateCheck(
				{ ...NEVER_PROBED, at: fresh.at, detail: 'private address: …' },
				NOW,
				PROBE_MAX_AGE_MS,
			),
		).toEqual({ id: PUBLIC_GATE_CHECK_ID, state: 'unknown', detail: 'unproven' });
	});

	test('attachProbe adds the probe + ONE public_gate check, replacing a previous one', () => {
		const row = {
			name: 'probe_host',
			checks: [
				{ id: 'reachable', state: 'ok' },
				{ id: PUBLIC_GATE_CHECK_ID, state: 'unknown', detail: 'old' },
			],
		} as unknown as HostPanelRow;
		const out = attachProbe(row, fresh, NOW, PROBE_MAX_AGE_MS);
		expect(out.public_probe).toEqual(fresh);
		expect(out.checks.map((c) => c.id)).toEqual(['reachable', PUBLIC_GATE_CHECK_ID]);
		expect(out.checks[1]?.state).toBe('ok');
		expect(row.checks).toHaveLength(2);
	});
});

describe('the source pins the module-state reason (module_state_tripwire)', () => {
	test('probeLanes is the only module-level Map in probe.ts', () => {
		const source = readFileSync(
			join(import.meta.dir, '../../src/core/publication_host/probe.ts'),
			'utf8',
		);
		expect(source.match(/^const \w+ = new Map/gm)).toEqual(['const probeLanes = new Map']);
	});
});

const ROOT: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
/** A profile admin: passes the dispatch gate, must NOT pass this one. */
const ADMIN: Principal = { userId: 5, isGlobalAdmin: true, isDeveloper: false };
const REPO = join(import.meta.dir, '..', '..');
const source = (rel: string) => stripComments(readFileSync(join(REPO, rel), 'utf8'));

describe('publication_hosts widget: probe_public (root-only) and the triggers', () => {
	const probePublic = (() => {
		const action = widget.apiActions?.probe_public;
		if (action === undefined) throw new Error('publication_hosts no longer registers probe_public');
		return action;
	})();

	test('a global admin who is not root → perm.denied, no probe, no runtime write', async () => {
		saveRegistry({ version: 1, hosts: [record({ public_url: null })] });
		await expect(probePublic({ name: 'probe_host' }, ADMIN)).rejects.toMatchObject({
			code: 'perm.denied',
		});
		expect((await loadRuntime()).probe_host).toBeUndefined();
	});

	test('root + an unknown host → maintenance.action_refused, no runtime write', async () => {
		saveRegistry({ version: 1, hosts: [] });
		await expect(probePublic({ name: 'nope_host' }, ROOT)).rejects.toMatchObject({
			code: 'maintenance.action_refused',
		});
		expect(await loadRuntime()).toEqual({});
	});

	test('root → the verdict is the payload and the runtime record', async () => {
		saveRegistry({ version: 1, hosts: [record({ public_url: null })] });
		const response = await probePublic({ name: 'probe_host' }, ROOT);
		expect(response.data).toMatchObject({ state: 'unknown', detail: 'the public URL is not set' });
		expect((await loadRuntime()).probe_host?.probe).toEqual(response.data as never);
		expect(response.msg).toContain('probe_host');
	});

	test("get_value attaches every row's probe + public_gate check from the runtime file", async () => {
		saveRegistry({ version: 1, hosts: [record({ public_url: null })] });
		await probePublic({ name: 'probe_host' }, ROOT);
		const value = await widget.getValue?.({}, ROOT);
		const rows = (
			value?.data as {
				hosts: {
					name: string;
					public_probe: unknown;
					checks: { id: string; state: string; detail?: string }[];
				}[];
			}
		).hosts;
		expect(rows.map((row) => row.name)).toEqual(['probe_host']);
		expect(rows[0]?.public_probe).toMatchObject({
			state: 'unknown',
			detail: 'the public URL is not set',
		});
		expect(rows[0]?.checks.at(-1)).toEqual({
			id: 'public_gate',
			state: 'unknown',
			detail: 'unproven',
		});
	});

	test('ONE copy trigger: the worker afterSync (server.ts) and the reconcile apply call it; applyCopy never does', () => {
		const server = source('src/server.ts');
		expect(server).toContain('afterSync: (host, report) =>');
		expect(server).toContain('scheduleProbeAfterCopyBatch(host, report)');
		expect(source('src/diffusion/api/media_copy_reconcile.ts')).toContain(
			'scheduleProbeAfterCopyBatch(name, report)',
		);
		for (const rel of [
			'src/diffusion/targets/mediastore/media_copy.ts',
			'src/diffusion/targets/mediastore/media_copy_apply.ts',
			'src/diffusion/targets/mediastore/media_copy_worker.ts',
		]) {
			expect(source(rel), `${rel} must not schedule a probe (one trigger per sync)`).not.toContain(
				'scheduleProbe',
			);
		}
	});
});
