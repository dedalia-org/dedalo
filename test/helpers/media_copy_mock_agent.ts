/**
 * A STATEFUL loopback (unix-socket) MOCK COPY AGENT for the media-copy reconcile and widget
 * gates (publication host phase 5, Task 10). Where publication_host_mock_agent.ts answers
 * scripted replies and keeps no state, this one HOLDS an agent's copy root in memory —
 * files `{size, sha256}` and `pub/` markers — so a whole reconcile round (manifest → mark
 * → put → delete → manifest) can converge against it. It speaks the phase-2 wire the
 * engine relies on: BASE_PATH, the one public GET /health publishing the fingerprint
 * (recipe from publication_host_mock_agent.ts mockFingerprint, never the engine's), the
 * bearer checked before any other route, RFC 9457 problem bodies with a machine `reason`,
 * and the copy-mode rules the real agent enforces (publication/host_agent src/media/copy.ts):
 * every media route answers 409 `media_mode` unless MEDIA_MODE=copy, and a put for a key
 * with no marker is refused 409 `key_unpublished` — up front AND at the landing. It is NOT
 * the agent: the agent's own package tests own its behaviour.
 *
 * `calls` logs every authenticated `METHOD /route`; `events` logs every mutation
 * (`put <path>`, `delete <path>`, `mark <key> <bool>`), in order. `setMode` re-declares the
 * agent's media mode (a host withdrawn from copy mode).
 *
 * Registration goes to the SCRATCH publication-hosts store only: `useScratchMediaCopyStores`
 * arms the ONE publication-hosts seam (registry + secrets + runtime, via
 * publication_host_fixtures.ts useScratchPublicationHostsBase) and the media-copy sha-cache
 * seam under the OS temp dir, so no gate ever writes the live <private>. Nothing here touches
 * a database or a media root.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetPairing } from '../../src/core/publication_host/agent_client.ts';
import {
	type PublicationHostRecord,
	publicationHostsTestRefusal,
	updateRegistry,
} from '../../src/core/publication_host/registry.ts';
import { removeHostRuntime } from '../../src/core/publication_host/runtime.ts';
import { removeHostSecrets, writeHostSecrets } from '../../src/core/publication_host/secrets.ts';
import { overrideMediaCopyStateDirForTests } from '../../src/diffusion/targets/mediastore/media_copy.ts';
import { useScratchPublicationHostsBase } from './publication_host_fixtures.ts';
import {
	MOCK_BASE_PATH,
	MOCK_PROBLEM_BASE,
	mockFingerprint,
} from './publication_host_mock_agent.ts';

export const COPY_MOCK_INSTANCE = 'test';
export const COPY_MOCK_TOKEN = 'zzmc_mock_agent_token_0123456789abcdef';

export type MockMode = 'shared' | 'copy' | 'none';
export interface MockEntry {
	size: number;
	sha256: string;
}
export interface MockSeed {
	entries?: Record<string, MockEntry>;
	markers?: string[];
}
export interface CopyMockAgent {
	readonly name: string;
	readonly entries: Map<string, MockEntry>;
	readonly markers: Set<string>;
	/** Paths media.delete answers `failed` (EACCES) for and keeps. */
	readonly undeletable: Set<string>;
	readonly calls: string[];
	readonly events: string[];
	setMode(mode: MockMode): void;
	stop(): Promise<void>;
}

interface State {
	mode: MockMode;
	entries: Map<string, MockEntry>;
	markers: Set<string>;
	undeletable: Set<string>;
	calls: string[];
	events: string[];
}

/**
 * Arm the publication-hosts store seam and the media-copy sha-cache seam under scratch
 * dirs for the calling file. ONCE per file, in its beforeAll; `dispose` in its afterAll.
 * `base` is the publication-hosts scratch base (registry, secrets, runtime).
 */
export function useScratchMediaCopyStores(): { base: string; dispose: () => void } {
	const hosts = useScratchPublicationHostsBase();
	const state = mkdtempSync(join(tmpdir(), 'zzmc-sha-'));
	overrideMediaCopyStateDirForTests(state);
	return {
		base: hosts.base,
		dispose: () => {
			overrideMediaCopyStateDirForTests(null);
			rmSync(state, { recursive: true, force: true });
			hosts.dispose();
		},
	};
}

export function sha256Hex(bytes: string | Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

const FINGERPRINT = mockFingerprint(COPY_MOCK_INSTANCE, COPY_MOCK_TOKEN);

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
			'cache-control': 'no-store',
		},
	});
}

function problem(status: number, reason: string): Response {
	return json(status, { type: `${MOCK_PROBLEM_BASE}${reason}`, title: reason, status, reason });
}

function mediaBody(state: State) {
	return {
		mode: state.mode,
		root: state.mode === 'none' ? null : '/srv/publication/media',
		present: state.mode !== 'none',
		read_only: state.mode === 'none' ? null : state.mode === 'shared',
		pub_readable: state.mode !== 'none',
		web_traversable: state.mode !== 'none' ? true : null,
		pub_markers: state.markers.size,
		problems: [],
	};
}

function statusBody(state: State) {
	return {
		agent_version: '0.1.0',
		bun_version: Bun.version,
		platform: 'linux',
		instance_fingerprint: FINGERPRINT,
		apis: { v1: { current: null, previous: null }, v2: { current: null, previous: null } },
		served_apis: ['v1', 'v2'],
		rules: { server: 'apache', hash: null },
		media: mediaBody(state),
		disk: { state_root_free_bytes: 1_000_000_000 },
	};
}

function manifestBody(state: State) {
	return {
		entries: [...state.entries.entries()]
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([path, entry]) => ({ path, size: entry.size, sha256: entry.sha256 })),
		irregular: [],
		markers: [...state.markers].sort(),
		next: null,
	};
}

/** `<component>_<key>.<ext>` → key (the agent's own reading, for the marker check). */
function keyOfPath(path: string): string | null {
	const match = /_([a-z0-9]+)_([0-9]+)(?:_lg-[a-zA-Z0-9-]{2,12})?\.[A-Za-z0-9]+$/.exec(path);
	return match === null ? null : `${match[1]}_${match[2]}`;
}

async function putFile(state: State, url: URL, req: Request): Promise<Response> {
	const path = url.searchParams.get('path') ?? '';
	const key = keyOfPath(path);
	if (key === null || !state.markers.has(key)) {
		await req.body?.cancel();
		return problem(409, 'key_unpublished');
	}
	const bytes = new Uint8Array(await req.arrayBuffer());
	const sha256 = sha256Hex(bytes);
	if (
		sha256 !== req.headers.get('x-sha256') ||
		String(bytes.length) !== req.headers.get('x-size')
	) {
		return problem(422, 'hash_mismatch');
	}
	// the real agent re-checks the marker under its key lock at the landing
	if (!state.markers.has(key)) return problem(409, 'key_unpublished');
	const replaced = state.entries.has(path);
	state.entries.set(path, { size: bytes.length, sha256 });
	state.events.push(`put ${path}`);
	return json(200, { path, key, size: bytes.length, sha256, replaced, unchanged: false });
}

async function deleteFiles(state: State, req: Request): Promise<Response> {
	const { paths } = (await req.json()) as { paths: string[] };
	// The real agent's per-path failure shape (copy.ts noteDeleteFailure): kept, reported.
	const failed = paths
		.filter((path) => state.undeletable.has(path))
		.map((path) => ({ path, error: 'EACCES' }));
	const deletable = paths.filter((path) => !state.undeletable.has(path));
	const deleted = deletable.filter((path) => state.entries.delete(path));
	for (const path of deletable) state.events.push(`delete ${path}`);
	return json(200, {
		deleted,
		absent: deletable.filter((path) => !deleted.includes(path)),
		failed,
	});
}

async function markKey(state: State, req: Request): Promise<Response> {
	const { key, published } = (await req.json()) as { key: string; published: boolean };
	const had = state.markers.has(key);
	if (published) state.markers.add(key);
	else state.markers.delete(key);
	state.events.push(`mark ${key} ${published}`);
	return json(200, { key, published, changed: had !== published });
}

function mediaRoute(
	state: State,
	route: string,
	url: URL,
	req: Request,
): Promise<Response> | Response {
	if (state.mode !== 'copy') return problem(409, 'media_mode');
	if (route === 'GET /v1/media/manifest') return json(200, manifestBody(state));
	if (route === 'PUT /v1/media/file') return putFile(state, url, req);
	if (route === 'POST /v1/media/delete') return deleteFiles(state, req);
	if (route === 'POST /v1/media/mark') return markKey(state, req);
	return problem(404, 'not_found');
}

async function handle(state: State, req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname.startsWith(`${MOCK_BASE_PATH}/`)
		? url.pathname.slice(MOCK_BASE_PATH.length)
		: url.pathname;
	if (req.method === 'GET' && path === '/health') {
		return json(200, {
			status: 'ok',
			service: 'dedalo-publication-host-agent',
			instance_fingerprint: FINGERPRINT,
		});
	}
	if (req.headers.get('authorization') !== `Bearer ${COPY_MOCK_TOKEN}`) {
		await req.body?.cancel();
		return problem(401, 'unauthorized');
	}
	const route = `${req.method} ${path}`;
	state.calls.push(route);
	if (route === 'GET /v1/status') return json(200, statusBody(state));
	if (route === 'GET /v1/media/probe') return json(200, mediaBody(state));
	return mediaRoute(state, route, url, req);
}

/**
 * Refuse BEFORE any store write unless the publication-host stores resolve under the OS temp
 * dir (useScratchMediaCopyStores armed) — makes the EXEMPT_WRITERS "scratch only" claim
 * (test_db_marker_tripwire) mechanically true: a gate that forgot to arm, or ran after
 * dispose, can never plant a zzmc host + bearer in the installation's live <private>.
 */
export function assertScratchCopyStores(door: string): void {
	const refusal = publicationHostsTestRefusal(true);
	if (refusal !== null) {
		throw new Error(
			`media_copy_mock_agent.${door} refused: ${refusal} (call useScratchMediaCopyStores first)`,
		);
	}
}

function registerCopyMockHost(name: string, socket: string): void {
	assertScratchCopyStores('registerCopyMockHost');
	const record: PublicationHostRecord = {
		name,
		instance: COPY_MOCK_INSTANCE,
		fingerprint: FINGERPRINT,
		address: { kind: 'unix', socket },
		public_url: null,
		qualities: null,
		probe: { published: null, unpublished: null },
		paired_at: new Date().toISOString(),
	};
	updateRegistry((cur) => ({
		version: 1,
		hosts: [...cur.hosts.filter((host) => host.name !== name), record],
	}));
	writeHostSecrets(name, COPY_MOCK_TOKEN, null);
}

/** Drop `name` from the scratch registry, its secrets, its runtime row and its pairing proof. */
export async function unregisterCopyMockHost(name: string): Promise<void> {
	assertScratchCopyStores('unregisterCopyMockHost');
	updateRegistry((cur) => ({ version: 1, hosts: cur.hosts.filter((host) => host.name !== name) }));
	removeHostSecrets(name);
	await removeHostRuntime(name);
	forgetPairing(name);
}

/**
 * Start a mock copy agent on a fresh unix socket (a 0700 mkdtemp dir under /tmp — the
 * door refuses a loosely housed socket, and macOS caps the path at 104 bytes) and register
 * it as host `name` in the scratch registry.
 */
export async function startCopyMockAgent(
	name: string,
	mode: MockMode,
	seed: MockSeed = {},
): Promise<CopyMockAgent> {
	assertScratchCopyStores('startCopyMockAgent');
	const dir = mkdtempSync('/tmp/zzmc-');
	const socket = join(dir, 'agent.sock');
	const state: State = {
		mode,
		entries: new Map(Object.entries(seed.entries ?? {})),
		markers: new Set(seed.markers ?? []),
		undeletable: new Set(),
		calls: [],
		events: [],
	};
	const server = Bun.serve({ unix: socket, fetch: (req) => handle(state, req) });
	registerCopyMockHost(name, socket);
	let stopped = false;
	return {
		name,
		entries: state.entries,
		markers: state.markers,
		undeletable: state.undeletable,
		calls: state.calls,
		events: state.events,
		setMode(next) {
			state.mode = next;
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			await server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
