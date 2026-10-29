/**
 * tool_sitebuilder proxy — unit tests against a mock daemon.
 *
 * The engine config is frozen at import, so we mock.module the config module to point the
 * tool at a real in-test Bun.serve standing in for the Site Builder daemon. That mock
 * server records every request, so we can assert the proxy attaches the bearer token and
 * the acting-user identity, maps daemon errors onto stable codes, enforces the publish
 * gate, and relays the SSE stream (every non-error record byte-for-byte; the error records
 * are the stream door's, test/unit/tool_sitebuilder_stream_codes.test.ts) with the
 * anti-buffering header.
 *
 * config.siteBuilder is a MUTABLE object here on purpose: daemon_client reads it per call,
 * so a test can flip the URL (to a dead port, or undefined) to exercise the unreachable
 * and unconfigured paths.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
// NAMESPACE imports for the reason lists: a gate that imported a not-yet-exported name would
// die at link time and report a setup error instead of the finding (WIRE-MAP gate-first).
import * as daemonErrors from '../../publication/site_builder/src/errors.ts';
// The DAEMON's error classes (a dependency-free module): the reasons it really sends.
import {
	CONFINEMENT_CODES,
	type ConfinementCode,
	ConfinementRefusedError,
	ConfinementUnavailableError,
} from '../../publication/site_builder/src/errors.ts';
import { WebspaceError } from '../../publication/site_builder/src/sites/site_table.ts';
// The daemon's OWN serializer: the stand-in answers with the bytes the daemon really sends.
import { problem as daemonProblem } from '../../publication/site_builder/src/util/response.ts';
import * as realConfigModule from '../../src/config/config.ts';
import { toErrorBody } from '../../src/core/errors/convert.ts';
import { ERROR_REGISTRY } from '../../src/core/errors/registry.ts';
import masterLabels from '../../src/core/labels/master.json';
import type { Principal } from '../../src/core/security/permissions.ts';
import { instanceFingerprint } from '../../src/core/site_builder/pairing.ts';
import type { ToolActionContext, ToolServerModule } from '../../src/core/tools/module.ts';
import * as wire from '../../tools/tool_sitebuilder/server/wire.ts';
import { CONFINEMENT_REASON_CODES } from '../../tools/tool_sitebuilder/server/wire.ts';
import { refusalOf } from '../helpers/refusal.ts';

// SNAPSHOT the real exports by spread BEFORE any mock.module runs (the code_update.test.ts
// convention). The namespace object itself is a LIVE view: once the module is mocked it
// reflects the mock, so re-installing the bare namespace in afterAll would re-install the
// mock and leak it into every later test file in a full-suite run.
const REAL_CONFIG_MODULE = { ...realConfigModule };

interface RecordedRequest {
	method: string;
	path: string;
	auth: string | null;
	userId: string | null;
	username: string | null;
	body: unknown;
}

const requests: RecordedRequest[] = [];
let server: ReturnType<typeof Bun.serve>;
// Mutable so tests can point it at a dead port / undefined.
const INSTANCE = 'test-instance';
const siteBuilder = {
	url: '',
	socket: undefined,
	instance: INSTANCE,
	token: 'test-token-abc',
	timeoutMs: 3000,
} as {
	url: string | undefined;
	socket: string | undefined;
	instance: string | undefined;
	token: string | undefined;
	timeoutMs: number;
};

/** What the mock daemon publishes when it is the instance this engine is paired with. */
function pairedFingerprint(): string {
	return instanceFingerprint(INSTANCE, siteBuilder.token as string);
}

let tool: ToolServerModule;

/**
 * WHAT THE MOCK DAEMON SAYS ABOUT ITS IDENTITY, swappable per test.
 *
 * The default is the truth (it is the paired instance). The pairing tests below replace it
 * with the three ways a daemon can be the WRONG one — another museum's instance, an
 * instance this engine has never heard of, and the right instance holding a different
 * token — and assert the engine refuses all three identically.
 */
let pairingAnswer: () => Record<string, unknown> = () => ({
	instance_fingerprint: pairedFingerprint(),
});

/**
 * THE DAEMON'S NEXT REFUSAL, when a gate sets one: the next non-/health request is answered
 * with exactly what the daemon's own `problem()` renders from this thrown value (status,
 * problem+json body, `reason` extension), then the slot clears.
 */
let nextProblem: unknown = null;

function ctx(principal: Principal, options: Record<string, unknown>): ToolActionContext {
	return { principal, userId: principal.userId, options, background: false };
}

const DEV: Principal = { userId: 7, isGlobalAdmin: false, isDeveloper: true };
const ADMIN: Principal = { userId: 8, isGlobalAdmin: true, isDeveloper: false };
const PLAIN: Principal = { userId: 9, isGlobalAdmin: false, isDeveloper: false };

beforeAll(async () => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			let body: unknown;
			if (req.method !== 'GET') {
				const text = await req.text();
				body = text ? JSON.parse(text) : undefined;
			}
			requests.push({
				method: req.method,
				path: url.pathname + url.search,
				auth: req.headers.get('authorization'),
				userId: req.headers.get('x-dedalo-user-id'),
				username: req.headers.get('x-dedalo-username'),
				body,
			});

			if (nextProblem !== null && url.pathname !== '/health') {
				const thrown = nextProblem;
				nextProblem = null;
				return daemonProblem(thrown);
			}
			// Canned responses keyed by path.
			if (url.pathname === '/health') {
				// The pairing fingerprint the engine recomputes and checks BEFORE it sends
				// anything (daemon_client.ts assertPaired). `pairingAnswer` lets one test make
				// this daemon claim to be somebody else.
				return Response.json({
					service: 'dedalo-site-builder',
					drivers: [],
					...pairingAnswer(),
				});
			}
			if (url.pathname === '/v1/sites' && req.method === 'GET') {
				return Response.json({ data: [{ manifest: { slug: 'demo' } }] });
			}
			if (url.pathname === '/v1/sites' && req.method === 'POST') {
				// The daemon's PLACEMENT refusal, verbatim in shape: a 409 problem document
				// carrying the machine `reason` the engine authors a sentence for, and the
				// daemon's own prose in `detail` (which must never reach the browser).
				if ((body as { slug?: string }).slug === 'undeclared') {
					return Response.json(
						{
							type: 'https://dedalo.dev/site-builder/problems/conflict',
							title: 'Conflict',
							status: 409,
							detail:
								"site 'undeclared' is not in instance 'myentity's site table " +
								"('/etc/dedalo_sites/instances/myentity/sites.json') … Nothing was written.",
							reason: 'webspace_unavailable',
						},
						{ status: 409 },
					);
				}
				return Response.json(
					{ manifest: { slug: (body as { slug: string }).slug } },
					{ status: 201 },
				);
			}
			if (url.pathname === '/v1/sites/demo/publish') {
				return Response.json({ release: 'r1', url: 'http://prod/demo/' });
			}
			if (url.pathname.startsWith('/v1/sites/') && req.method === 'DELETE') {
				return Response.json({
					deleted: url.pathname.split('/')[3],
					purged_prod: url.searchParams.get('purge_prod') === 'true',
				});
			}
			if (url.pathname === '/v1/audit') {
				return Response.json({ data: [{ action: 'publish', site: 'demo' }] });
			}
			if (url.pathname === '/force-403') {
				return Response.json({ title: 'Unauthorized' }, { status: 403 });
			}
			// THE DAEMON'S OWN CONFINEMENT REFUSALS, rendered the way its problem() renders
			// any ApiError (type/title/status/detail + extensions): one slug per reason.
			const confined = /^\/v1\/sites\/confined-([a-z-]+)\/sessions$/.exec(url.pathname);
			if (confined) {
				const code = (confined[1] as string).replace(/-/g, '_');
				const error =
					code === 'unavailable'
						? new ConfinementUnavailableError('daemon prose: no systemd here')
						: new ConfinementRefusedError(code as ConfinementCode, `daemon prose: refused ${code}`);
				return Response.json(
					{
						type: error.type,
						title: error.title,
						status: error.status,
						detail: error.detail,
						...error.extensions,
					},
					{ status: error.status },
				);
			}
			// A real busy refusal, as the daemon's session manager throws it (sessions/manager.ts).
			if (url.pathname === '/v1/sites/rejectme/sessions') {
				return daemonProblem(
					new daemonErrors.ConflictError(
						"A turn is already running for 'rejectme'",
						'session_running',
					),
				);
			}
			// A 4xx the daemon sends WITHOUT a machine reason (a malformed request): the status
			// fallback is all the engine has, and the daemon's prose still stays off the wire.
			if (url.pathname === '/v1/sites/validationme/sessions') {
				return daemonProblem(new daemonErrors.ValidationError('daemon prose: prompt too long'));
			}
			if (url.pathname.endsWith('/events')) {
				const sse =
					'id: 0\ndata: {"seq":0,"body":{"type":"turn_start"}}\n\nid: 1\ndata: {"seq":1,"body":{"type":"turn_end","state":"idle"}}\n\n';
				return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
			}
			return Response.json({ detail: 'not found' }, { status: 404 });
		},
	});
	siteBuilder.url = `http://127.0.0.1:${server.port}`;

	mock.module('../../src/config/config.ts', () => ({
		...REAL_CONFIG_MODULE,
		config: { ...REAL_CONFIG_MODULE.config, siteBuilder },
	}));

	// Import AFTER the mock so daemon_client/index bind to the mocked config.
	({ tool } = await import('../../tools/tool_sitebuilder/server/index.ts'));
});

afterAll(() => {
	server.stop(true);
	mock.module('../../src/config/config.ts', () => REAL_CONFIG_MODULE);
	mock.restore();
});

/**
 * What the client READS of a refusal: the converter's body WITHOUT the debug block (present
 * only under DEDALO_DEBUG_API_ERRORS=true, a developer's own machine — never a museum's wire).
 */
function wireOf(refusal: Parameters<typeof toErrorBody>[0]): string {
	const { debug: _debug, ...wireBody } = toErrorBody(refusal);
	return JSON.stringify(wireBody);
}

function lastRequest(): RecordedRequest {
	return requests[requests.length - 1]!;
}

describe('tool_sitebuilder proxy', () => {
	test('isAvailable reflects configuration', () => {
		expect(
			tool.isAvailable?.({
				callerModel: 'section',
				tipo: '',
				sectionTipo: '',
				isComponent: false,
				mode: 'list',
				hasToolConfig: false,
			}),
		).toBe(true);
	});

	test('list_sites forwards with bearer token and acting-user headers', async () => {
		const res = await tool.apiActions.list_sites!.handler(ctx(DEV, {}));
		expect(res.data).toEqual({ data: [{ manifest: { slug: 'demo' } }] });
		const req = lastRequest();
		expect(req.auth).toBe('Bearer test-token-abc');
		expect(req.userId).toBe('7');
		expect(req.username).toBe('user_7');
	});

	test('the token never appears in a serialized ToolResponse', async () => {
		const res = await tool.apiActions.list_sites!.handler(ctx(DEV, {}));
		expect(JSON.stringify(res)).not.toContain('test-token-abc');
	});

	test('create_site validates the slug before proxying and sends the actor in the body', async () => {
		const bad = await refusalOf(
			tool.apiActions.create_site!.handler(
				ctx(DEV, { slug: 'Bad Slug', name: 'x', domain: 'demo.example.org' }),
			),
		);
		// Its OWN code (WIRE-MAP): the label is the sentence, so no prose rides the throw.
		expect(bad.code).toBe('site_builder.invalid_slug');
		expect(bad.publicMessage).toBeUndefined();

		const good = await tool.apiActions.create_site!.handler(
			ctx(DEV, { slug: 'demo', name: 'Demo', domain: 'demo.example.org' }),
		);
		expect(good.data).toEqual({ manifest: { slug: 'demo' } });
		const req = lastRequest();
		expect(req.body).toMatchObject({
			slug: 'demo',
			name: 'Demo',
			// THE DOMAIN. The tool sent {slug, name} and no domain at all, so once the daemon
			// made it required every create through the engine failed — and the engine is the
			// only door a museum has to this daemon.
			domain: 'demo.example.org',
			actor: { user_id: 7, username: 'user_7' },
		});
	});

	test('create_site refuses a MISSING domain before proxying', async () => {
		// PRESENCE, which is not a grammar. "You did not say which domain" deserves an
		// engine-authored sentence rather than a relayed 400, and it costs no round trip.
		for (const domain of [undefined, '', '   ']) {
			const before = requests.length;
			const refusal = await refusalOf(
				tool.apiActions.create_site!.handler(ctx(DEV, { slug: 'demo', name: 'Demo', domain })),
			);
			expect(refusal.code).toBe('site_builder.domain_required');
			expect(refusal.publicMessage).toBeUndefined();
			expect(requests.length, 'a missing domain still cost a round trip').toBe(before);
		}
	});

	test("the SHAPE of a domain is the daemon's to judge — this side no longer forks the grammar", async () => {
		// This tool used to carry its own DOMAIN_PATTERN, documented as "deliberately not
		// stricter" than the provisioner's and stricter in two ways: four characters minimum
		// against one, and a `[a-z]{2,63}` final label against any label. So `a.b` and `x.123`
		// were domains the provisioner builds a webspace and two vhosts for and the museum's
		// only door refused to create a site on, with a sentence about DNS.
		//
		// The fork is gone (test/unit/site_builder_single_source_tripwire.test.ts, fact
		// `layout_constants`, holds it gone), so these now REACH the owner — which is the
		// regression this asserts, not the daemon's verdict on them.
		for (const domain of ['a.b', 'x.123']) {
			const before = requests.length;
			await tool.apiActions.create_site!.handler(ctx(DEV, { slug: 'demo', name: 'Demo', domain }));
			expect(requests.length, `'${domain}' was refused locally again`).toBe(before + 1);
			expect(lastRequest().body).toMatchObject({ domain });
		}
	});

	test('a domain typed with capitals or spaces is normalized, not refused', async () => {
		// A hostname is case-insensitive and an operator types one into a form; the daemon
		// stores and compares it lowercased, so normalizing here is agreeing with it rather
		// than being lenient.
		await tool.apiActions.create_site!.handler(
			ctx(DEV, { slug: 'demo', name: 'Demo', domain: '  WWW.Example.ORG ' }),
		);
		expect(lastRequest().body).toMatchObject({ domain: 'www.example.org' });
	});

	test('a placement refusal reaches the user as its OWN code, whose label is the sentence', async () => {
		// The daemon's own careful prose stays log-only (the rule this file's other assertions
		// rest on). What crosses is the engine's sentence for the machine `reason` the daemon
		// sent — otherwise a museum sees a refusal with no explanation at all, for a condition
		// only whoever administers the server can fix.
		const refusal = await refusalOf(
			tool.apiActions.create_site!.handler(
				ctx(DEV, { slug: 'undeclared', name: 'Undeclared', domain: 'undeclared.example.org' }),
			),
		);
		expect(refusal.code).toBe('site_builder.webspace_unavailable');
		expect(refusal.publicMessage).toBeUndefined();
		const body = toErrorBody(refusal);
		// What error_text renders is the registry label of THIS code, not the generic one.
		expect(body.label_key).toBe('error_site_builder_webspace_unavailable');
		expect(String((masterLabels as Record<string, string>)[body.label_key] ?? '')).not.toBe('');
		// And the daemon's own words are NOT what the browser is shown.
		expect(wireOf(refusal)).not.toContain('site table');
	});

	test('publish is denied to a plain user, allowed to a developer and a global admin', async () => {
		const denied = await refusalOf(
			tool.apiActions.publish!.handler(ctx(PLAIN, { slug: 'demo', confirm: true })),
		);
		expect(denied.code).toBe('site_builder.not_permitted');

		// Developer, but no confirm → refused before proxying.
		const noConfirm = await refusalOf(tool.apiActions.publish!.handler(ctx(DEV, { slug: 'demo' })));
		expect(noConfirm.code).toBe('site_builder.confirmation_required');

		const dev = await tool.apiActions.publish!.handler(ctx(DEV, { slug: 'demo', confirm: true }));
		expect(dev.data).toMatchObject({ release: 'r1' });

		const admin = await tool.apiActions.publish!.handler(
			ctx(ADMIN, { slug: 'demo', confirm: true }),
		);
		expect(admin.data).toMatchObject({ release: 'r1' });
	});

	/**
	 * The delete_site gate, as P2-8(b) redrew it. It used to be split where the daemon
	 * splits `deleteSite(slug, purgeProd)` (site_builder src/sites/workspace.ts): only the
	 * `purgeProd` half — the one touching PROD_ROOT — was gated, and the plain half, which
	 * destroys the WORKSPACE and the preprod copy, was ordinary tool work for any grantee.
	 * That was wrong in the same way the rest of the tool was: destroying somebody's
	 * unpublished work needs authorization too, and an unpublished site has no prod release
	 * history to be restored from. So the publisher grant now covers BOTH halves, and
	 * purge_prod keeps its extra explicit-confirm requirement on top.
	 */
	test('delete_site without purge_prod is now publisher-gated too, and never reaches the daemon for a plain user', async () => {
		const before = requests.length;
		const denied = await refusalOf(
			tool.apiActions.delete_site!.handler(ctx(PLAIN, { slug: 'demo' })),
		);
		expect(denied.code).toBe('site_builder.not_permitted');
		expect(requests.length).toBe(before);

		const res = await tool.apiActions.delete_site!.handler(ctx(DEV, { slug: 'demo' }));
		expect(res.data).toMatchObject({ deleted: 'demo', purged_prod: false });
		const req = lastRequest();
		expect(req.method).toBe('DELETE');
		expect(req.path).toBe('/v1/sites/demo');
		expect(req.body).toMatchObject({ actor: { user_id: 7 } });
	});

	test('delete_site --purge_prod is refused to a plain user and never reaches the daemon', async () => {
		const before = requests.length;
		const denied = await refusalOf(
			tool.apiActions.delete_site!.handler(
				ctx(PLAIN, { slug: 'demo', purge_prod: true, confirm: true }),
			),
		);
		expect(denied.code).toBe('site_builder.not_permitted');
		// Fails closed BEFORE the proxy call: the daemon trusts us entirely, so a refusal
		// that still sent the DELETE would have purged production anyway.
		expect(requests.length).toBe(before);
	});

	test('delete_site --purge_prod requires an explicit confirm, even for a developer', async () => {
		const before = requests.length;
		const refusal = await refusalOf(
			tool.apiActions.delete_site!.handler(ctx(DEV, { slug: 'demo', purge_prod: true })),
		);
		expect(refusal.code).toBe('site_builder.confirmation_required');
		expect(refusal.publicMessage).toBeUndefined();
		expect(requests.length).toBe(before);
	});

	test('delete_site --purge_prod is allowed to a developer and a global admin, confirmed', async () => {
		const dev = await tool.apiActions.delete_site!.handler(
			ctx(DEV, { slug: 'demo', purge_prod: true, confirm: true }),
		);
		expect(dev.data).toMatchObject({ deleted: 'demo', purged_prod: true });
		expect(lastRequest().path).toBe('/v1/sites/demo?purge_prod=true');

		const admin = await tool.apiActions.delete_site!.handler(
			ctx(ADMIN, { slug: 'demo', purge_prod: true, confirm: true }),
		);
		expect(admin.data).toMatchObject({ purged_prod: true });
		expect(lastRequest().path).toBe('/v1/sites/demo?purge_prod=true');
	});

	test('get_audit is developer/admin-gated', async () => {
		const denied = await refusalOf(tool.apiActions.get_audit!.handler(ctx(PLAIN, {})));
		expect(denied.code).toBe('site_builder.not_permitted');
		const allowed = await tool.apiActions.get_audit!.handler(ctx(ADMIN, {}));
		expect(allowed.data).toMatchObject({ data: [{ action: 'publish' }] });
	});

	test('a daemon busy refusal maps to site_builder.busy (retryable), and its prose stays OFF the wire', async () => {
		const refusal = await refusalOf(
			tool.apiActions.session_start!.handler(ctx(DEV, { slug: 'rejectme', prompt: 'go' })),
		);
		expect(refusal.code).toBe('site_builder.busy');
		expect(ERROR_REGISTRY['site_builder.busy'].retryable).toBe(true);
		// The daemon's own detail is LOG-only: it is on `message`…
		expect(refusal.message).toContain('already running');
		// …and NEVER offered as the vetted public sentence, so another service can
		// never write this install's browser-facing error text.
		expect(refusal.publicMessage).toBeUndefined();
		expect(wireOf(refusal)).not.toContain('already running');
	});

	test('a daemon 4xx WITHOUT a machine reason falls back to site_builder.rejected, prose off the wire', async () => {
		const refusal = await refusalOf(
			tool.apiActions.session_start!.handler(ctx(DEV, { slug: 'validationme', prompt: 'go' })),
		);
		expect(refusal.code).toBe('site_builder.rejected');
		expect(refusal.message).toContain('daemon prose');
		expect(refusal.publicMessage).toBeUndefined();
		expect(wireOf(refusal)).not.toContain('daemon prose');
	});

	/**
	 * THE DAEMON'S CONFINEMENT REFUSALS SAY WHO MUST ACT. Every reason the daemon can send
	 * (its CONFINEMENT_CODES, plus `confinement_unavailable`) is mapped — the two lists are
	 * held equal, so a code added daemon-side without a mapping here is red — and each lands
	 * on a registered 503 code: `site_builder.busy` (retryable: it clears by itself) or
	 * `site_builder.confinement_unavailable` (not: an operator must act). Before, all of them
	 * fell through to `site_builder.failed`, "retryable", for a host that will not change.
	 */
	test('every daemon confinement reason maps to a registered, typed 503 — and its prose stays OFF the wire', async () => {
		const reasons = [
			'confinement_unavailable',
			...CONFINEMENT_CODES.map((code) => `confinement.${code}`),
		].sort();
		expect(Object.keys(CONFINEMENT_REASON_CODES).sort()).toEqual(reasons);
		const BUSY = new Set([
			'site_busy',
			'identity_quarantined',
			'daemon_stopping',
			'agent_cli_unproved',
		]);
		for (const code of ['unavailable', ...CONFINEMENT_CODES]) {
			const refusal = await refusalOf(
				tool.apiActions.session_start!.handler(
					ctx(DEV, { slug: `confined-${code.replace(/_/g, '-')}`, prompt: 'go' }),
				),
			);
			const expected = BUSY.has(code)
				? 'site_builder.busy'
				: 'site_builder.confinement_unavailable';
			expect({ code, mapped: refusal.code }).toEqual({ code, mapped: expected });
			const row = ERROR_REGISTRY[expected as keyof typeof ERROR_REGISTRY];
			expect({ code, status: row.status, retryable: row.retryable }).toEqual({
				code,
				status: 503,
				retryable: BUSY.has(code),
			});
			// The daemon's sentence is LOG-only.
			expect(refusal.message).toContain('daemon prose');
			expect(refusal.publicMessage).toBeUndefined();
		}
	});

	test('get_status reports reachable true, and false when the daemon is down', async () => {
		const up = await tool.apiActions.get_status!.handler(ctx(DEV, {}));
		expect(up.data).toMatchObject({ configured: true, reachable: true, can_publish: true });
		// THE PAIRING FINGERPRINT NEVER REACHES A BROWSER. It is a sha256 over the shared
		// bearer, published by the daemon so THIS PROCESS can prove the pairing; relaying it
		// in the status payload would hand every user of the tool an offline brute-force
		// target against the installation's site-builder token.
		const health = (up.data as { health: Record<string, unknown> }).health;
		expect(health.service).toBe('dedalo-site-builder');
		expect(health).not.toHaveProperty('instance_fingerprint');
		expect(JSON.stringify(up)).not.toContain(pairedFingerprint());

		const savedUrl = siteBuilder.url;
		siteBuilder.url = 'http://127.0.0.1:1'; // nothing listening
		// A PUBLISHER asks: since P2-8(b) get_status is gated like everything else, so a
		// plain user gets a refusal here rather than a status body (the reachability
		// answer is itself a disclosure about the installation's infrastructure).
		const down = await tool.apiActions.get_status!.handler(ctx(ADMIN, {}));
		expect(down.data).toMatchObject({ configured: true, reachable: false, can_publish: true });
		siteBuilder.url = savedUrl;

		const denied = await refusalOf(tool.apiActions.get_status!.handler(ctx(PLAIN, {})));
		expect(denied.code).toBe('site_builder.not_permitted');
	});

	/**
	 * A DAEMON THAT IS NOT THIS MUSEUM'S IS REFUSED AT THE TOOL'S DOOR.
	 *
	 * The mechanism and its indistinguishability are gated in
	 * test/unit/site_builder_pairing_tripwire.test.ts; what this pins is the LAST mile —
	 * that the refusal survives the action layer as a registered code the client can branch
	 * on, and that a status probe reports it honestly instead of claiming a working daemon.
	 */
	test('a daemon that is not the paired instance refuses, and status says so', async () => {
		// A pairing this process has never proved (the proven one is cached for the life of
		// the module), against a daemon that answers with somebody else's identity.
		const savedToken = siteBuilder.token;
		siteBuilder.token = 'a-token-this-process-has-not-proved-yet';
		pairingAnswer = () => ({ instance_fingerprint: instanceFingerprint(INSTANCE, 'elsewhere') });

		const refusal = await refusalOf(tool.apiActions.list_sites!.handler(ctx(DEV, {})));
		expect(refusal.code).toBe('site_builder.instance_mismatch');
		// Operator disclosure: nothing the browser reads names the instance or the token.
		expect(JSON.stringify(refusal.publicMessage ?? '')).not.toContain(INSTANCE);

		const status = await tool.apiActions.get_status!.handler(ctx(DEV, {}));
		expect(status.data).toMatchObject({
			configured: true,
			reachable: false,
			error: 'site_builder.instance_mismatch',
		});

		siteBuilder.token = savedToken;
		pairingAnswer = () => ({ instance_fingerprint: pairedFingerprint() });
	});

	test('unconfigured install: every action fails closed and isAvailable is false', async () => {
		const savedUrl = siteBuilder.url;
		siteBuilder.url = undefined;
		expect(
			tool.isAvailable?.({
				callerModel: 'section',
				tipo: '',
				sectionTipo: '',
				isComponent: false,
				mode: 'list',
				hasToolConfig: false,
			}),
		).toBe(false);
		const refusal = await refusalOf(tool.apiActions.list_sites!.handler(ctx(DEV, {})));
		expect(refusal.code).toBe('site_builder.unconfigured');
		siteBuilder.url = savedUrl;
	});

	test('an id carrying a dot-segment is refused before it can rewrite the daemon path', async () => {
		// `..` passes the character class but the URL parser resolves it away:
		// /v1/sessions/../stop → /v1/stop. Refuse it at the seam, and never reach the daemon.
		const before = requests.length;
		for (const id of ['..', 'a/../b', '..%2e', 'x..y']) {
			const stop = await refusalOf(
				tool.apiActions.session_stop!.handler(ctx(DEV, { session_id: id })),
			);
			expect(stop.code, id).toBe('site_builder.invalid_id');
		}
		const build = await refusalOf(
			tool.apiActions.get_build!.handler(ctx(DEV, { slug: 'demo', build_id: '..' })),
		);
		expect(build.code).toBe('site_builder.invalid_id');
		// The stream never opens: the refusal is a throw, so there is no body
		// carrying a half-open stream.
		const stream = await refusalOf(
			tool.apiActions.session_stream!.handler(ctx(DEV, { session_id: '..' })),
		);
		expect(stream.code).toBe('site_builder.invalid_id');
		// Nothing reached the daemon.
		expect(requests.length).toBe(before);
	});

	// ADMIN, not DEV: session_stream is ownership-gated since P2-8(b) and 'abc' has no
	// owner row, so a developer would (correctly) be refused before the stream opens. The
	// global-admin bypass keeps THIS test about the SSE bytes; the ownership rule itself is
	// gated in tool_sitebuilder_authz_native.test.ts.
	// NON-ERROR RECORDS ARE BYTE-IDENTICAL (WIRE-MAP stream door): only an error record is
	// projected onto a registered code (test/unit/tool_sitebuilder_stream_codes.test.ts); every
	// other record reaches the browser exactly as the daemon framed it.
	test('session_stream relays non-error records byte-identical and sets the anti-buffering header', async () => {
		const res = await tool.apiActions.session_stream!.handler(
			ctx(ADMIN, { session_id: 'abc', after: -1 }),
		);
		expect(res.ok).toBe(true);
		expect(res.streamContentType).toContain('text/event-stream');
		expect((res.streamHeaders as Record<string, string>)['X-Accel-Buffering']).toBe('no');

		const stream = res.stream as ReadableStream<Uint8Array>;
		const text = await new Response(stream).text();
		expect(text).toBe(
			'id: 0\ndata: {"seq":0,"body":{"type":"turn_start"}}\n\nid: 1\ndata: {"seq":1,"body":{"type":"turn_end","state":"idle"}}\n\n',
		);
	});
});

/**
 * WIRE-MAP — EVERY REASON THE DAEMON SENDS LANDS ON ITS OWN REGISTERED CODE.
 *
 * Before: only the confinement reasons were mapped. `slug_exists`, `workspace_exists`, the
 * six busy reasons, `no_build`, `not_running` and the three limits fell through to the
 * status default — `site_builder.rejected` (400, "rejected", not retryable) — so a museum
 * was told "the site builder rejected the request" for "that name is taken", "a build is
 * running, try again" and "the server is full" alike, and a retryable condition read as a
 * permanent one. The browser never shows a daemon's or an engine's prose
 * (render_api_error.js reads the LABEL first), so the code IS the message.
 *
 * Driven end to end: the stand-in daemon answers with the bytes its own serializer
 * (`util/response.ts problem()`) renders from the REAL class it throws, the REAL handler
 * maps it, and the ONE converter (`toErrorBody`) builds what the client reads.
 */
describe('WIRE-MAP — every daemon reason → its own code', () => {
	/**
	 * THE CONTRACT (engineering/wire_contract WC-2026-10-11-site-builder-reason-codes): each
	 * reason the daemon sends and the code a museum must read for it. Pinned here, beside the
	 * gate, because a map that is only compared with itself cannot be wrong.
	 */
	const BUSY = [
		'session_running',
		'build_running',
		'site_initializing',
		'site_recovering',
		'git_running',
		'site_deleting',
	] as const;
	const EXPECTED: Readonly<Record<string, string>> = {
		...Object.fromEntries(BUSY.map((reason) => [reason, 'site_builder.busy'])),
		slug_exists: 'site_builder.slug_exists',
		workspace_exists: 'site_builder.workspace_exists',
		domain_taken: 'site_builder.domain_taken',
		webspace_unavailable: 'site_builder.webspace_unavailable',
		no_build: 'site_builder.no_build',
		not_running: 'site_builder.not_running',
		max_sites: 'site_builder.site_limit',
		disk_quota: 'site_builder.disk_quota',
		max_concurrent_sessions: 'site_builder.capacity',
		confinement_unavailable: 'site_builder.confinement_unavailable',
		'confinement.site_busy': 'site_builder.busy',
		'confinement.identity_missing': 'site_builder.confinement_unavailable',
		'confinement.identity_quarantined': 'site_builder.busy',
		'confinement.unit_refused': 'site_builder.confinement_unavailable',
		'confinement.unit_nonconformant': 'site_builder.confinement_unavailable',
		'confinement.daemon_stopping': 'site_builder.busy',
		'confinement.agent_cli_unsupported': 'site_builder.confinement_unavailable',
		'confinement.agent_cli_unproved': 'site_builder.busy',
	};
	const RETRYABLE = new Set<string>([
		...BUSY,
		'max_concurrent_sessions',
		'confinement.site_busy',
		'confinement.identity_quarantined',
		'confinement.daemon_stopping',
		'confinement.agent_cli_unproved',
	]);
	const GENERIC = new Set(['site_builder.rejected', 'site_builder.failed', 'internal.unexpected']);
	const PROSE = 'daemon prose: refused for';

	/** The daemon's reason lists, read off the daemon's own module (absent pre-fix: an empty list, named). */
	const lists = daemonErrors as unknown as Record<string, readonly string[] | undefined>;
	const DAEMON_REASONS: readonly string[] = lists.DAEMON_REASONS ?? [];

	/** The thrown value the daemon raises for one reason — its REAL class, as its throw sites do. */
	function daemonThrowFor(reason: string): unknown {
		const detail = `${PROSE} ${reason}`;
		if (reason === 'webspace_unavailable') return new WebspaceError(detail);
		if (reason === 'confinement_unavailable')
			return new daemonErrors.ConfinementUnavailableError(detail);
		if (reason.startsWith('confinement.')) {
			return new daemonErrors.ConfinementRefusedError(
				reason.slice('confinement.'.length) as ConfinementCode,
				detail,
			);
		}
		if (
			(lists.LIMIT_REASONS ?? ['max_sites', 'disk_quota', 'max_concurrent_sessions']).includes(
				reason,
			)
		) {
			return new daemonErrors.LimitExceededError(detail, reason as never);
		}
		return new daemonErrors.ConflictError(detail, reason as never);
	}

	test('(a) the daemon exports its reason lists, the engine maps exactly them, and the contract names every one', () => {
		// The daemon's reason vocabulary is a runtime list the engine is gated against — a reason
		// added daemon-side without a row here (or in wire.ts) is red, never a silent fallback.
		expect({
			DAEMON_REASONS: Array.isArray(lists.DAEMON_REASONS),
			CONFLICT_REASONS: Array.isArray(lists.CONFLICT_REASONS),
			LIMIT_REASONS: Array.isArray(lists.LIMIT_REASONS),
			BUSY_REASONS: Array.isArray(lists.BUSY_REASONS),
		}).toEqual({
			DAEMON_REASONS: true,
			CONFLICT_REASONS: true,
			LIMIT_REASONS: true,
			BUSY_REASONS: true,
		});
		expect([...DAEMON_REASONS].sort()).toEqual(Object.keys(EXPECTED).sort());
		expect([...(lists.BUSY_REASONS ?? [])].sort()).toEqual([...BUSY].sort());
		const map = (wire as unknown as { DAEMON_REASON_CODES?: Readonly<Record<string, string>> })
			.DAEMON_REASON_CODES;
		expect(
			map === undefined ? 'wire.ts exports no DAEMON_REASON_CODES' : Object.keys(map).sort(),
		).toEqual([...DAEMON_REASONS].sort());
	});

	for (const reason of Object.keys(EXPECTED)) {
		test(`(b) '${reason}' → ${EXPECTED[reason]}, its own label, prose off the wire`, async () => {
			nextProblem = daemonThrowFor(reason);
			const refusal = await refusalOf(
				reason === 'slug_exists' || reason === 'domain_taken' || reason === 'max_sites'
					? tool.apiActions.create_site!.handler(
							ctx(DEV, { slug: 'demo', name: 'Demo', domain: 'demo.example.org' }),
						)
					: reason === 'no_build'
						? tool.apiActions.publish!.handler(ctx(DEV, { slug: 'demo', confirm: true }))
						: tool.apiActions.session_start!.handler(ctx(DEV, { slug: 'demo', prompt: 'go' })),
			);
			nextProblem = null;
			const code = EXPECTED[reason] as string;
			expect({ reason, code: refusal.code as string }).toEqual({ reason, code });
			expect(GENERIC.has(refusal.code)).toBe(false);
			const row = ERROR_REGISTRY[code as keyof typeof ERROR_REGISTRY];
			expect({ reason, registered: row !== undefined }).toEqual({ reason, registered: true });
			if (!row) return;
			expect({ reason, retryable: row.retryable }).toEqual({
				reason,
				retryable: RETRYABLE.has(reason),
			});
			const body = toErrorBody(refusal);
			// What error_text renders: THIS code's label — present, and not the generic one.
			expect(body.label_key).toBe(`error_${code.replace(/\./g, '_')}`);
			expect(body.label_key).not.toBe('error_site_builder_rejected');
			const label = (masterLabels as Record<string, string>)[body.label_key];
			expect({ reason, label: typeof label === 'string' && label.trim() !== '' }).toEqual({
				reason,
				label: true,
			});
			// The daemon's sentence is LOG-only.
			expect(refusal.message).toContain(PROSE);
			expect(wireOf(refusal)).not.toContain(PROSE);
		});
	}

	/**
	 * THE ENGINE'S OWN REFUSALS — the same law: a code per refusal, its label is the sentence,
	 * and nothing rides `publicMessage` (the browser never shows it). `perm.*` maps to the
	 * no-access PAGE in a tool panel, so the permission refusals are `site_builder.*` too.
	 */
	const ENGINE_REFUSALS: ReadonlyArray<readonly [string, string, () => Promise<unknown>]> = [
		[
			'an invalid slug',
			'site_builder.invalid_slug',
			() =>
				tool.apiActions.create_site!.handler(
					ctx(DEV, { slug: 'Bad Slug', name: 'x', domain: 'x.example.org' }),
				),
		],
		[
			'an invalid id',
			'site_builder.invalid_id',
			() => tool.apiActions.session_stop!.handler(ctx(DEV, { session_id: 'a/../b' })),
		],
		[
			'no publisher grant',
			'site_builder.not_permitted',
			() => tool.apiActions.list_sites!.handler(ctx(PLAIN, {})),
		],
		[
			'no name',
			'site_builder.name_required',
			() =>
				tool.apiActions.create_site!.handler(
					ctx(DEV, { slug: 'demo', name: '  ', domain: 'demo.example.org' }),
				),
		],
		[
			'no domain',
			'site_builder.domain_required',
			() =>
				tool.apiActions.create_site!.handler(ctx(DEV, { slug: 'demo', name: 'Demo', domain: '' })),
		],
		[
			'no prompt',
			'site_builder.text_required',
			() => tool.apiActions.session_start!.handler(ctx(DEV, { slug: 'demo', prompt: '' })),
		],
		[
			'no message',
			'site_builder.text_required',
			() =>
				tool.apiActions.session_message!.handler(ctx(ADMIN, { session_id: 'abc', message: ' ' })),
		],
		[
			'publish unconfirmed',
			'site_builder.confirmation_required',
			() => tool.apiActions.publish!.handler(ctx(DEV, { slug: 'demo' })),
		],
		[
			'purge unconfirmed',
			'site_builder.confirmation_required',
			() => tool.apiActions.delete_site!.handler(ctx(DEV, { slug: 'demo', purge_prod: true })),
		],
	];

	for (const [what, code, run] of ENGINE_REFUSALS) {
		test(`(c) ${what} → ${code}, its own label, no prose on the throw`, async () => {
			const before = requests.length;
			const refusal = await refusalOf(run());
			expect({ what, code: refusal.code as string }).toEqual({ what, code });
			expect(refusal.publicMessage).toBeUndefined();
			const row = ERROR_REGISTRY[code as keyof typeof ERROR_REGISTRY];
			expect({ what, registered: row !== undefined }).toEqual({ what, registered: true });
			if (row) {
				const label = (masterLabels as Record<string, string>)[row.label_key];
				expect(row.label_key).not.toBe('error_site_builder_rejected');
				expect({ what, label: typeof label === 'string' && label.trim() !== '' }).toEqual({
					what,
					label: true,
				});
			}
			// Refused before the daemon was asked anything.
			expect(requests.length).toBe(before);
		});
	}
});
