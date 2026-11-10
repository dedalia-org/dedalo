/**
 * A LOOPBACK MOCK PUBLICATION AGENT for the engine-side client gates (publication host,
 * phase 3).
 *
 * It speaks the phase-2 agent's wire (publication/host_agent): BASE_PATH
 * /publication/host_agent; GET /health as the one public route, publishing
 * `instance_fingerprint`; the bearer checked BEFORE any other route (401 otherwise);
 * RFC 9457 problem bodies with a machine `reason`; `X-Dedalo-Actor` on mutations; the
 * release headers X-Release-Id / X-Bundle-Sha256 with a raw gzip body; copy mode's media
 * put (`?path=`, X-Sha256, X-Size, raw body), delete and mark; the host-wide nginx map's
 * `POST /v1/rules/map` and `status.rules.map` (provision init §13.4: `null` by default, an
 * Apache host — script GET /v1/status or use mockNginxStatus for an nginx one). It is NOT the
 * agent: it keeps no state on disk, answers what a test scripts into it, and RECORDS every
 * request so a gate can assert what crossed the wire — above all, whether a bearer did.
 *
 * The fingerprint is computed HERE from the recipe (sha256 of 'dedalo-publication-host:' +
 * instance + '\n' + token), never imported from the engine: a client gate that passes then
 * proves the engine agrees with the recipe, not with itself.
 *
 * TLS: the PKI is Task 1's (test/helpers/publication_host_fixtures.ts mintTestPki — server
 * SAN IP:127.0.0.1, engine bundle = client cert + PKCS#8 key + CA). The TLS listener
 * requires and verifies the client certificate (phase-2 D1). This file writes nothing to
 * disk; a unix listener binds the socket path its caller chose.
 */

import type { TestPki } from './publication_host_fixtures.ts';

export const MOCK_BASE_PATH = '/publication/host_agent';
export const MOCK_PROBLEM_BASE = 'https://dedalo.dev/publication-host/problems/';

/** The pairing recipe, spelled independently of the engine (see header). */
export function mockFingerprint(instance: string, token: string): string {
	return new Bun.CryptoHasher('sha256')
		.update(`dedalo-publication-host:${instance}\n${token}`)
		.digest('hex');
}

export interface RecordedRequest {
	method: string;
	/** The full request pathname, BASE_PATH included. */
	path: string;
	/** The raw query string ('' when none; '?…' otherwise). */
	query: string;
	authorization: string | null;
	actor: string | null;
	contentType: string | null;
	releaseId: string | null;
	bundleSha256: string | null;
	/** The copy-mode put metadata headers (X-Sha256, X-Size). */
	sha256: string | null;
	size: string | null;
	body: Uint8Array;
}

export interface MockReply {
	status: number;
	/** A string is sent verbatim; anything else as JSON. */
	body: unknown;
}

export type MockListen = { kind: 'tls'; pki: TestPki } | { kind: 'unix'; socket: string };

export interface MockAgent {
	/** The TCP port (tls), 0 for a unix socket. */
	readonly port: number;
	readonly requests: RecordedRequest[];
	/** Re-provision the mock: /health publishes, and the bearer gate expects, this token. */
	setToken(token: string): void;
	/** Make GET /v1/status report this fingerprint (null = the honest one). */
	setStatusFingerprint(fingerprint: string | null): void;
	/** Script one authenticated route's answer (route = path below BASE_PATH). */
	reply(method: 'GET' | 'POST' | 'PUT', route: string, reply: MockReply): void;
	/** Back to the start token, no scripted replies, no recorded requests. */
	reset(): void;
	stop(): void;
}

/** An RFC 9457 problem body as the agent renders it. */
export function mockProblem(
	status: number,
	slug: string,
	title: string,
	detail: string,
	extensions: Record<string, unknown> = {},
): MockReply {
	return {
		status,
		body: { type: `${MOCK_PROBLEM_BASE}${slug}`, title, status, detail, ...extensions },
	};
}

export const MOCK_PROBE = Object.freeze({
	mode: 'shared',
	root: '/srv/dedalo_media',
	present: true,
	read_only: true,
	pub_readable: true,
	web_traversable: true,
	pub_markers: 2,
	problems: [] as string[],
});

export function mockStatus(fingerprint: string): Record<string, unknown> {
	return {
		agent_version: '0.1.0',
		bun_version: Bun.version,
		platform: 'linux',
		instance_fingerprint: fingerprint,
		apis: {
			v1: { current: '7.0.2_aaaaaaa', previous: null },
			v2: { current: '7.0.2_aaaaaaa', previous: '7.0.1_bbbbbbb' },
		},
		served_apis: ['v1', 'v2'],
		rules: { server: 'apache', hash: null, map: null },
		media: { ...MOCK_PROBE, problems: [] },
		disk: { state_root_free_bytes: 1_073_741_824 },
	};
}

/**
 * An nginx host's status: `map` is the agent's `rules.map` — `'absent'` drops the key (an agent
 * that predates the host map), `{managed:false}` a hand-placed map, else the managed shape.
 */
export function mockNginxStatus(
	fingerprint: string,
	map: Record<string, unknown> | null | 'absent' = MOCK_MANAGED_MAP,
): Record<string, unknown> {
	const status = mockStatus(fingerprint);
	const rules: Record<string, unknown> = { server: 'nginx', hash: null };
	if (map !== 'absent') rules.map = map;
	return { ...status, rules };
}

/** A managed host map with nothing of this instance loaded yet. */
export const MOCK_MANAGED_MAP = Object.freeze({
	managed: true,
	hash: null,
	host_hash: null,
	contributions: 0,
	invalid: 0,
	refused: null,
});

function respond(status: number, body: unknown): Response {
	return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
		status,
		headers: {
			'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
			'cache-control': 'no-store',
		},
	});
}

async function record(req: Request): Promise<RecordedRequest> {
	return {
		method: req.method,
		path: new URL(req.url).pathname,
		query: new URL(req.url).search,
		authorization: req.headers.get('authorization'),
		actor: req.headers.get('x-dedalo-actor'),
		contentType: req.headers.get('content-type'),
		releaseId: req.headers.get('x-release-id'),
		bundleSha256: req.headers.get('x-bundle-sha256'),
		sha256: req.headers.get('x-sha256'),
		size: req.headers.get('x-size'),
		body: new Uint8Array(await req.arrayBuffer()),
	};
}

function routeOf(path: string): string {
	return path.startsWith(`${MOCK_BASE_PATH}/`) ? path.slice(MOCK_BASE_PATH.length) : '';
}

/** The agent's PutResult for the recorded put (no state: every put lands as new). */
function mediaPutAnswer(r: RecordedRequest): Record<string, unknown> {
	const path = new URLSearchParams(r.query).get('path') ?? '';
	const match = /_([a-z0-9]+)_([0-9]+)(?:_lg-[a-zA-Z0-9-]{2,12})?\.[A-Za-z0-9]+$/.exec(path);
	return {
		path,
		key: match === null ? null : `${match[1]}_${match[2]}`,
		size: Number(r.size),
		sha256: r.sha256,
		replaced: false,
		unchanged: false,
	};
}

function defaultAnswer(r: RecordedRequest, route: string, statusFingerprint: string): Response {
	switch (`${r.method} ${route}`) {
		case 'GET /v1/status':
			return respond(200, mockStatus(statusFingerprint));
		case 'GET /v1/media/probe':
			return respond(200, MOCK_PROBE);
		case 'POST /v1/rules/apply':
			return respond(200, {
				hash: (JSON.parse(new TextDecoder().decode(r.body)) as { hash: string }).hash,
				reloaded: true,
			});
		case 'POST /v1/rules/map': {
			// The agent answers from root's result.json: this mock's host file is this one contribution.
			const { hash } = JSON.parse(new TextDecoder().decode(r.body)) as { hash: string };
			return respond(200, { hash, host_hash: hash, contributions: 1, reloaded: true });
		}
		case 'POST /v1/releases/v1':
		case 'POST /v1/releases/v2':
			return respond(200, {
				api: route.slice(-2),
				from: '7.0.2_aaaaaaa',
				to: r.releaseId,
				reused: false,
				health: 'ok',
			});
		case 'PUT /v1/media/file':
			return respond(200, mediaPutAnswer(r));
		case 'POST /v1/media/delete':
			return respond(200, {
				deleted: (JSON.parse(new TextDecoder().decode(r.body)) as { paths: string[] }).paths,
				absent: [],
				failed: [],
			});
		case 'POST /v1/media/mark': {
			const mark = JSON.parse(new TextDecoder().decode(r.body)) as {
				key: string;
				published: boolean;
			};
			return respond(200, { key: mark.key, published: mark.published, changed: true });
		}
		case 'POST /v1/releases/v1/rollback':
		case 'POST /v1/releases/v2/rollback':
			return respond(200, { from: '7.0.3_a1b2c3d', to: '7.0.2_aaaaaaa' });
		default:
			return respond(404, mockProblem(404, 'not-found', 'Not Found', 'No such route.').body);
	}
}

export function startMockAgent(listen: MockListen, instance: string, token: string): MockAgent {
	const requests: RecordedRequest[] = [];
	const scripted = new Map<string, MockReply>();
	let currentToken = token;
	let statusFingerprint: string | null = null;
	let stopped = false;

	const answer = (r: RecordedRequest): Response => {
		const honest = mockFingerprint(instance, currentToken);
		const route = routeOf(r.path);
		if (r.method === 'GET' && route === '/health') {
			return respond(200, {
				status: 'ok',
				service: 'dedalo-publication-host-agent',
				instance_fingerprint: honest,
			});
		}
		if (r.authorization !== `Bearer ${currentToken}`) {
			return respond(
				401,
				mockProblem(401, 'unauthorized', 'Unauthorized', 'Missing or invalid bearer token.').body,
			);
		}
		const reply = scripted.get(`${r.method} ${route}`);
		if (reply !== undefined) return respond(reply.status, reply.body);
		return defaultAnswer(r, route, statusFingerprint ?? honest);
	};
	const fetchHandler = async (req: Request): Promise<Response> => {
		const recorded = await record(req);
		requests.push(recorded);
		return answer(recorded);
	};
	const server =
		listen.kind === 'tls'
			? Bun.serve({
					hostname: '127.0.0.1',
					port: 0,
					tls: {
						cert: listen.pki.serverCertPem,
						key: listen.pki.serverKeyPem,
						ca: listen.pki.caPem,
						requestCert: true,
						rejectUnauthorized: true,
					},
					fetch: fetchHandler,
				})
			: Bun.serve({ unix: listen.socket, fetch: fetchHandler });

	return {
		port: listen.kind === 'tls' ? (server.port ?? 0) : 0,
		requests,
		setToken(next: string) {
			currentToken = next;
		},
		setStatusFingerprint(fingerprint: string | null) {
			statusFingerprint = fingerprint;
		},
		reply(method: 'GET' | 'POST' | 'PUT', route: string, reply: MockReply) {
			scripted.set(`${method} ${route}`, reply);
		},
		reset() {
			currentToken = token;
			statusFingerprint = null;
			scripted.clear();
			requests.length = 0;
		},
		stop() {
			if (stopped) return;
			stopped = true;
			server.stop(true);
		},
	};
}
