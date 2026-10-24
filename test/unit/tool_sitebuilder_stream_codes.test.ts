/**
 * G-W1 — WIRE-MAP, THE STREAM DOOR: a turn's error reaches the browser as a REGISTERED CODE, never
 * as the daemon's prose.
 *
 * Before: the control door (problem+json) was mapped — every daemon `reason` onto its own
 * `site_builder.*` code, the daemon's `detail` log-only — but the STREAM door was a byte-for-byte
 * pass-through (`index.ts` sessionStream). A turn the daemon refused for a named reason
 * (`confinement.identity_missing`, a busy site, a CLI that cannot be restricted) became a stored
 * `{type:'error', message:'confinement refused: <the daemon's whole sentence>'}` event, relayed
 * verbatim: the browser rendered the daemon's prose (paths, uids, an agent CLI's stderr), no code,
 * no label, no retryable flag; the `replay_failed` frame carried the raw exception text.
 *
 * After (outcomes, driven end to end — nothing here is a hand-built frame):
 *
 *   1. the DAEMON half is real: each refusal is raised inside the real supervisor
 *      (`spawnAgentProcess`) through BOTH of its doors — the driver's setup throwing it, and the
 *      confinement door throwing it — plus real situations (an identity that is not there, a
 *      daemon that is stopping); the events it queues are stored and served by the daemon's own
 *      store and SSE responder (`appendEvent` → `sessionEventStream`), so the bytes are the
 *      daemon's;
 *   2. the ENGINE half is real: a stand-in daemon serves those bytes SPLIT MID-RECORD, with a
 *      `text` record, a `: ping` and a real `replay_failed` frame among them, and the real
 *      `session_stream` handler relays them;
 *   3. what the browser receives: every error record's body carries `error` = the ONE
 *      converter's body (`toErrorBody`) for the code the reason maps to — its registry
 *      `retryable`, a label that exists — and NOT ONE BYTE of the daemon's prose; every other
 *      record is byte-identical; a legacy `{type:'error', message}` record (a log written before
 *      the fix) becomes `site_builder.failed` with its text gone; a trailing record with no
 *      terminator is projected, never flushed raw;
 *   4. parity: the engine's stream map covers EXACTLY the reasons the daemon's stream can carry,
 *      and the daemon's `retriable` for each is the registry's `retryable` for its code.
 *
 * The expected map is PINNED here (the design's table), never read from wire.ts: a map compared
 * only with itself cannot be wrong. Codes a refusal maps to that the registry lacks are RED here
 * by design until the integrator lands their rows (they would otherwise convert to
 * `internal.unexpected`, which is worse than HEAD).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as daemonConfig } from '../../publication/site_builder/src/config.ts';
import {
	type ConfinementPolicy,
	policyFromConfig,
	stopOpeningRuns,
} from '../../publication/site_builder/src/drivers/confinement.ts';
import { spawnAgentProcess } from '../../publication/site_builder/src/drivers/process.ts';
import type {
	AgentEvent,
	SessionStartOptions,
} from '../../publication/site_builder/src/drivers/types.ts';
import * as daemonErrors from '../../publication/site_builder/src/errors.ts';
import { sessionEventStream } from '../../publication/site_builder/src/sessions/sse.ts';
import { appendEvent } from '../../publication/site_builder/src/sessions/store.ts';
import { end, tryBegin } from '../../publication/site_builder/src/workspace_activity.ts';
import * as realConfigModule from '../../src/config/config.ts';
import { ERROR_REGISTRY } from '../../src/core/errors/registry.ts';
import masterLabels from '../../src/core/labels/master.json';
import type { Principal } from '../../src/core/security/permissions.ts';
import { instanceFingerprint } from '../../src/core/site_builder/pairing.ts';
import type { ToolActionContext, ToolServerModule } from '../../src/core/tools/module.ts';
import * as wire from '../../tools/tool_sitebuilder/server/wire.ts';

const REAL_CONFIG_MODULE = { ...realConfigModule };

/** The daemon's prose — in every refusal the daemon raises here; never in a byte the browser gets. */
const SENTINEL = 'ZZ_DAEMON_PROSE_51c9';
const ADMIN: Principal = { userId: 8, isGlobalAdmin: true, isDeveloper: false };
const INSTANCE = 'test-instance';
const siteBuilder = {
	url: '',
	socket: undefined,
	instance: INSTANCE,
	token: 'test-token-stream',
	timeoutMs: 5000,
} as { url: string; socket: undefined; instance: string; token: string; timeoutMs: number };

/* ────────────────────────────────────────────────────────────────────────────────────
 * The contract, pinned (design A3; the daemon half restates WC-2026-10-11-site-builder-reason-codes)
 * ──────────────────────────────────────────────────────────────────────────────────── */

const BUSY = [
	'session_running',
	'build_running',
	'site_initializing',
	'site_recovering',
	'git_running',
	'site_deleting',
];
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
	// The supervisor's own faults and the SSE responder's frame (design A3).
	turn_timeout: 'site_builder.turn_timeout',
	turn_interrupted: 'site_builder.turn_interrupted',
	turn_setup_failed: 'site_builder.turn_setup_failed',
	turn_agent_exited: 'site_builder.agent_failed',
	turn_unit_lost: 'site_builder.failed',
	turn_agent_killed: 'site_builder.failed',
	turn_failed: 'site_builder.failed',
	replay_failed: 'site_builder.replay_failed',
};
/** The registry rows the integrator adds (design integrator_requests 1), retryable as stated there. */
const NEW_CODE_RETRYABLE: Readonly<Record<string, boolean>> = {
	'site_builder.turn_timeout': true,
	'site_builder.turn_interrupted': true,
	'site_builder.turn_setup_failed': false,
	'site_builder.agent_failed': false,
	'site_builder.replay_failed': false,
};

const registry = ERROR_REGISTRY as Readonly<
	Record<string, { retryable: boolean; label_key: string } | undefined>
>;
const labels = masterLabels as Readonly<Record<string, string>>;

/* ────────────────────────────────────────────────────────────────────────────────────
 * The stand-in daemon (its /events serve whatever a test queued, SPLIT MID-RECORD)
 * ──────────────────────────────────────────────────────────────────────────────────── */

/** What the stand-in serves for one session id: the chunks, in order, and how the stream ends. */
const served = new Map<string, { chunks: string[]; fail?: boolean }>();
let server: ReturnType<typeof Bun.serve>;
let tool: ToolServerModule;

function ctx(options: Record<string, unknown>): ToolActionContext {
	return { principal: ADMIN, userId: ADMIN.userId, options, background: false };
}

beforeAll(async () => {
	server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === '/health') {
				return Response.json({
					service: 'dedalo-site-builder',
					drivers: [],
					instance_fingerprint: instanceFingerprint(INSTANCE, siteBuilder.token),
				});
			}
			const match = /^\/v1\/sessions\/([^/]+)\/events$/.exec(url.pathname);
			const plan = match ? served.get(match[1] as string) : undefined;
			if (!plan) return Response.json({ detail: 'not found' }, { status: 404 });
			const encoder = new TextEncoder();
			let at = 0;
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					// One chunk per pull, a pause between: each one a separate read on the engine's side.
					await Bun.sleep(3);
					if (at < plan.chunks.length) {
						controller.enqueue(encoder.encode(plan.chunks[at++] as string));
						return;
					}
					if (plan.fail) controller.error(new Error(`${SENTINEL} upstream died`));
					else controller.close();
				},
			});
			return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
		},
	});
	siteBuilder.url = `http://127.0.0.1:${server.port}`;
	mock.module('../../src/config/config.ts', () => ({
		...REAL_CONFIG_MODULE,
		config: { ...REAL_CONFIG_MODULE.config, siteBuilder },
	}));
	({ tool } = await import('../../tools/tool_sitebuilder/server/index.ts'));
});

afterAll(() => {
	server.stop(true);
	mock.module('../../src/config/config.ts', () => REAL_CONFIG_MODULE);
	mock.restore();
	rmSync(join(daemonConfig.SITES_ROOT, SLUG), { recursive: true, force: true });
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * The daemon half — real events, real store, real SSE bytes
 * ──────────────────────────────────────────────────────────────────────────────────── */

/** The daemon-side site the sessions are stored under (a scratch workspace in the package's test root). */
const SLUG = 'zzstreamcodes';
const scratch: string[] = [];

function workspace(): string {
	const ws = join(daemonConfig.SITES_ROOT, SLUG);
	mkdirSync(ws, { recursive: true });
	return ws;
}

function startOptions(): SessionStartOptions {
	return {
		slug: SLUG,
		workspace: workspace(),
		prompt: 'go',
		mcp: { name: 'dedalo_publication', url: 'http://127.0.0.1:9/mcp' },
		env: { PATH: '/usr/bin:/bin' },
		timeoutMs: 10_000,
	};
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const out: AgentEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

/** A declared-unconfined policy with a state root of this test's own. */
function nonePolicy(): ConfinementPolicy {
	const root = join(
		tmpdir(),
		`zzstream-state-${process.pid}-${Math.random().toString(36).slice(2)}`,
	);
	scratch.push(root);
	return { ...policyFromConfig(), mode: 'none', agentStateRoot: root };
}

/** A policy whose confinement door throws `error` (confineTurn reads the mode first). */
function throwingPolicy(error: Error): ConfinementPolicy {
	return new Proxy({} as ConfinementPolicy, {
		get(_target, key) {
			if (key === 'mode') throw error;
			return undefined;
		},
	});
}

/** A confined policy of its own (its lease is keyed by the socket dir), with no identity at all. */
function confinedPolicy(): ConfinementPolicy {
	return {
		...policyFromConfig(),
		mode: 'systemd_scope',
		identities: new Map(),
		agentSocketDir: join(tmpdir(), `zzstream-sock-${Math.random().toString(36).slice(2)}`),
	};
}

function refusalFor(reason: string): Error {
	const detail = `${SENTINEL} refused for ${reason}`;
	if (reason === 'confinement_unavailable')
		return new daemonErrors.ConfinementUnavailableError(detail);
	return new daemonErrors.ConfinementRefusedError(
		reason.slice('confinement.'.length) as daemonErrors.ConfinementCode,
		detail,
	);
}

/** One turn's events, with the reason the design says its error carries. */
interface Produced {
	readonly label: string;
	readonly reason: string;
	readonly events: AgentEvent[];
	/** The daemon's own prose for a REAL refusal (its message), which must not cross either. */
	readonly prose: string;
}

async function setupDoor(reason: string): Promise<Produced> {
	const events = await drain(
		spawnAgentProcess(
			startOptions(),
			async () => {
				throw refusalFor(reason);
			},
			nonePolicy(),
		).events,
	);
	return { label: `setup door: ${reason}`, reason, events, prose: SENTINEL };
}

async function confinementDoor(reason: string): Promise<Produced> {
	const events = await drain(
		spawnAgentProcess(
			startOptions(),
			async () => ({ argv: ['/usr/bin/true'], parseLine: () => [] }),
			throwingPolicy(refusalFor(reason)),
		).events,
	);
	return { label: `confinement door: ${reason}`, reason, events, prose: SENTINEL };
}

/** A REAL refusal of the real confineTurn: the site holds its reservation, the policy says why not. */
async function realSituation(code: 'identity_missing' | 'daemon_stopping'): Promise<Produced> {
	const policy = confinedPolicy();
	if (code === 'daemon_stopping') stopOpeningRuns(policy);
	const opts = startOptions();
	expect(tryBegin(SLUG, 'turn')).toBe(true);
	try {
		const events = await drain(
			spawnAgentProcess(
				opts,
				async () => ({ argv: ['/usr/bin/true'], parseLine: () => [] }),
				policy,
			).events,
		);
		// The real sentence is the daemon's: its distinctive clause must not cross.
		const prose =
			code === 'identity_missing'
				? 'has no agent identity (AGENT_IDENTITIES)'
				: 'the daemon is shutting down';
		return { label: `real situation: ${code}`, reason: `confinement.${code}`, events, prose };
	} finally {
		end(SLUG, 'turn');
	}
}

let sessionCounter = 0;

/**
 * THE DAEMON'S BYTES for a session holding `bodies`: stored by its real store, served by its real
 * SSE responder (no turn running, so it replays and closes).
 */
async function daemonBytes(bodies: readonly unknown[]): Promise<{ id: string; bytes: string }> {
	workspace();
	const id = `zzs${process.pid}x${++sessionCounter}`;
	for (const body of bodies) await appendEvent(SLUG, id, body as never);
	const bytes = await new Response(sessionEventStream(SLUG, id, -1).body).text();
	return { id, bytes };
}

/** A REAL `replay_failed` frame: the session's log is a directory, so the replay throws. */
async function replayFailedFrame(): Promise<string> {
	const id = `zzs${process.pid}x${++sessionCounter}broken`;
	mkdirSync(join(workspace(), '.builder', 'sessions', `${id}.jsonl`), { recursive: true });
	return new Response(sessionEventStream(SLUG, id, -1).body).text();
}

/** Every SSE record split IN TWO at its middle — so a record never arrives whole in one read. */
function splitMidRecord(bytes: string): string[] {
	const chunks: string[] = [];
	for (const record of bytes.split(/(?<=\n\n)/)) {
		if (record.length < 2) {
			chunks.push(record);
			continue;
		}
		const half = Math.floor(record.length / 2);
		chunks.push(record.slice(0, half), record.slice(half));
	}
	return chunks;
}

/** Relay `chunks` through the REAL engine handler; the browser's bytes. */
async function relay(chunks: string[], fail = false): Promise<string> {
	const id = `zzrelay${++sessionCounter}`;
	served.set(id, { chunks, fail });
	const res = await tool.apiActions.session_stream!.handler(ctx({ session_id: id, after: -1 }));
	return new Response(res.stream as ReadableStream<Uint8Array>).text();
}

interface SseRecord {
	readonly raw: string;
	readonly event: string | null;
	// biome-ignore lint/suspicious/noExplicitAny: a parsed SSE record, read loosely by the gate (its shape is what is asserted)
	readonly data: Record<string, any> | null;
}

function records(text: string): SseRecord[] {
	return text
		.split('\n\n')
		.filter((raw) => raw.trim() !== '')
		.map((raw) => {
			const event = /^event: (.*)$/m.exec(raw)?.[1] ?? null;
			const dataLine = /^data: (.*)$/m.exec(raw)?.[1];
			// biome-ignore lint/suspicious/noExplicitAny: a parsed SSE record, read loosely by the gate
			let data: Record<string, any> | null = null;
			try {
				data = dataLine === undefined ? null : JSON.parse(dataLine);
			} catch {
				data = null;
			}
			return { raw, event, data };
		});
}

/** What the browser must read for one reason: the converter's body for its code. */
// biome-ignore lint/suspicious/noExplicitAny: the relayed error body, read loosely (its shape is what is asserted)
function codeShape(error: Record<string, any> | undefined) {
	const code = String(error?.code ?? '(no code)');
	const row = registry[code];
	const label = row ? labels[row.label_key] : undefined;
	return {
		code,
		registered: row !== undefined,
		retryable: row ? error?.retryable === row.retryable : 'unregistered',
		labelled:
			typeof label === 'string' && label.trim() !== '' && error?.label_key === row?.label_key,
	};
}

const TEXT_BODY = { type: 'text', text: 'the agent said a harmless thing' };
const LEGACY = 'LEGACY_DAEMON_SENTENCE_9e2';

/* ────────────────────────────────────────────────────────────────────────────────────
 * 1–3. end to end, per reason and per door
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe('G-W1 — a turn’s refusal reaches the browser as its registered code, through both daemon doors', () => {
	const REASONS = [
		'confinement_unavailable',
		...daemonErrors.CONFINEMENT_CODES.map((code) => `confinement.${code}`),
	];
	const producers: Array<[string, () => Promise<Produced>]> = [
		...REASONS.map(
			(reason) =>
				[`setup door: ${reason}`, () => setupDoor(reason)] as [string, () => Promise<Produced>],
		),
		...REASONS.map(
			(reason) =>
				[`confinement door: ${reason}`, () => confinementDoor(reason)] as [
					string,
					() => Promise<Produced>,
				],
		),
		['real situation: identity_missing', () => realSituation('identity_missing')],
		['real situation: daemon_stopping', () => realSituation('daemon_stopping')],
	];

	for (const [label, produce] of producers) {
		test(label, async () => {
			const produced = await produce();
			const errorEvents = produced.events.filter((event) => event.type === 'error');
			expect({ label, errorEvents: errorEvents.length }).toEqual({ label, errorEvents: 1 });
			const { bytes } = await daemonBytes([
				{ type: 'turn_start', turn: 1, prompt: 'go' },
				TEXT_BODY,
				...errorEvents,
				{ type: 'turn_end', state: 'error' },
			]);
			const replayFailed = await replayFailedFrame();
			const upstream = `${bytes}: ping\n\n${replayFailed}`;
			const out = await relay(splitMidRecord(upstream));

			// Not one byte of the daemon's prose — in a record, a frame or anywhere.
			expect({
				label,
				prose: out.includes(produced.prose),
				sentinel: out.includes(SENTINEL),
			}).toEqual({ label, prose: false, sentinel: false });

			const all = records(out);
			const errorRecord = all.find((record) => record.data?.body?.type === 'error');
			// biome-ignore lint/suspicious/noExplicitAny: the relayed record body, read loosely
			const body = (errorRecord?.data?.body ?? {}) as Record<string, any>;
			expect({
				label,
				message: Object.hasOwn(body, 'message') ? 'daemon message relayed' : 'none',
			}).toEqual({ label, message: 'none' });
			expect({ label, ...codeShape(body.error) }).toEqual({
				label,
				code: EXPECTED[produced.reason] as string,
				registered: true,
				retryable: true,
				labelled: true,
			});

			// Every non-error record is byte-identical: the text record and the ping.
			const textRaw =
				records(bytes).find((record) => record.data?.body?.type === 'text')?.raw ??
				'(no text record upstream)';
			expect({
				label,
				text: out.includes(`${textRaw}\n\n`),
				ping: out.includes(': ping\n\n'),
			}).toEqual({ label, text: true, ping: true });

			// The replay_failed frame: the converter's body, its own code, no daemon exception text.
			const frame = all.find((record) => record.event === 'error');
			expect({
				label,
				...codeShape(frame?.data ?? undefined),
				daemonKeys: Object.keys(frame?.data ?? {}).filter(
					(key) => key === 'message' && frame?.data?.code === 'replay_failed',
				),
			}).toEqual({
				label,
				code: 'site_builder.replay_failed',
				registered: true,
				retryable: true,
				labelled: true,
				daemonKeys: [],
			});
		});
	}
});

describe('G-W1 — the relay’s own edges', () => {
	test('a LEGACY error record (a log from before the fix: prose, no reason) becomes site_builder.failed, its text gone', async () => {
		const { bytes } = await daemonBytes([
			TEXT_BODY,
			{ type: 'error', message: LEGACY, retriable: true },
		]);
		const out = await relay(splitMidRecord(bytes));
		expect(out.includes(LEGACY)).toBe(false);
		const body = records(out).find((record) => record.data?.body?.type === 'error')?.data?.body;
		expect(codeShape(body?.error)).toEqual({
			code: 'site_builder.failed',
			registered: true,
			retryable: true,
			labelled: true,
		});
	});

	test('an error record with a reason this engine does not know is site_builder.failed (never relayed verbatim)', async () => {
		const { bytes } = await daemonBytes([
			{ type: 'error', reason: 'zz_future_reason', retriable: false, message: LEGACY },
		]);
		const out = await relay(splitMidRecord(bytes));
		expect({ legacy: out.includes(LEGACY), reason: out.includes('zz_future_reason') }).toEqual({
			legacy: false,
			reason: false,
		});
		const body = records(out).find((record) => record.data?.body?.type === 'error')?.data?.body;
		expect(codeShape(body?.error).code).toBe('site_builder.failed');
	});

	test('a reason spelled like an Object.prototype key is UNKNOWN at both doors (G5): the fallback, never a prototype member', () => {
		// The maps are plain objects: a lookup by `in` or by bare indexing would take `__proto__`,
		// `constructor`, `toString`… as LISTED reasons and answer a function or Object.prototype as
		// the code. Each is the daemon's text, not a reason this engine knows.
		const PROTO = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
		const control = wire.codeForProblem({ reason: 'slug_exists' }, 'site_builder.rejected');
		const problems = Object.fromEntries(
			PROTO.map((reason) => [reason, wire.codeForProblem({ reason }, 'site_builder.rejected')]),
		);
		const frames = Object.fromEntries(
			PROTO.map((reason) => {
				const projected = wire.projectStreamRecord(
					`data: ${JSON.stringify({ seq: 1, ts: 't', body: { type: 'error', reason } })}`,
				);
				return [reason, records(`${projected ?? ''}\n\n`)[0]?.data?.body?.error?.code ?? '(none)'];
			}),
		);
		expect({ control, problems, frames }).toEqual({
			control: 'site_builder.slug_exists',
			problems: Object.fromEntries(PROTO.map((reason) => [reason, 'site_builder.rejected'])),
			frames: Object.fromEntries(PROTO.map((reason) => [reason, 'site_builder.failed'])),
		});
	});

	test('a TRAILING error record with no terminator is projected, never flushed raw', async () => {
		const produced = await setupDoor('confinement.identity_missing');
		const { bytes } = await daemonBytes([
			TEXT_BODY,
			...produced.events.filter((event) => event.type === 'error'),
		]);
		const unterminated = bytes.replace(/\n\n$/, '');
		const out = await relay(splitMidRecord(unterminated));
		expect(out.includes(SENTINEL)).toBe(false);
		const body = records(out).find((record) => record.data?.body?.type === 'error')?.data?.body;
		expect(codeShape(body?.error).code).toBe('site_builder.confinement_unavailable');
	});

	test('the engine’s own stream_lost frame is the converter’s FULL body (§5.3), the cause log-only', async () => {
		const { bytes } = await daemonBytes([TEXT_BODY]);
		const out = await relay(splitMidRecord(bytes), true);
		expect(out.includes(SENTINEL)).toBe(false);
		const frame = records(out).find((record) => record.event === 'error');
		expect(codeShape(frame?.data ?? undefined)).toEqual({
			code: 'site_builder.stream_lost',
			registered: true,
			retryable: true,
			labelled: true,
		});
		expect(Object.keys(frame?.data ?? {}).sort()).toEqual(
			expect.arrayContaining(['category', 'code', 'label_key', 'message', 'retryable']),
		);
	});

	test('a DROPPED record (not JSON) alone in its read never stalls the stream: the records after it and the close still arrive', async () => {
		// The hazard: a pull whose only complete record was dropped enqueues nothing, and a pull
		// that enqueues nothing is not called again — the browser's read would never resolve.
		// Bounded: a hang fails this test at its timeout instead of hanging the suite.
		const { bytes } = await daemonBytes([TEXT_BODY, { type: 'turn_end', state: 'done' }]);
		const upstream = records(bytes).map((record) => `${record.raw}\n\n`);
		const out = await relay(['data: ZZ_NOT_JSON at all\n\n', ...upstream]);
		const textRaw = records(bytes).find((record) => record.data?.body?.type === 'text')?.raw;
		const endRaw = records(bytes).find((record) => record.data?.body?.type === 'turn_end')?.raw;
		expect({
			dropped: out.includes('ZZ_NOT_JSON'),
			text: textRaw !== undefined && out.includes(`${textRaw}\n\n`),
			turnEnd: endRaw !== undefined && out.includes(`${endRaw}\n\n`),
		}).toEqual({ dropped: false, text: true, turnEnd: true });
	}, 5000);

	test('a stream of ONLY dropped records still closes (the end of the upstream reaches the browser)', async () => {
		const out = await relay(['data: ZZ_NOT_JSON one\n\n', 'data: 42\n\n', 'data: null\n\n']);
		expect(out).toBe('');
	}, 5000);

	test('agent_output crosses ONLY for turn_agent_exited, and only its last 500 chars', async () => {
		const tail = 'ZZ_TAIL_END';
		const long = `${'s'.repeat(2000)}${tail}`;
		const { bytes } = await daemonBytes([
			{ type: 'error', reason: 'turn_timeout', retriable: true, agent_output: 'ZZ_TIMEOUT_OUT' },
			{ type: 'error', reason: 'turn_failed', retriable: false, agent_output: 'ZZ_FAILED_OUT' },
			{ type: 'error', reason: 'turn_agent_exited', retriable: false, agent_output: long },
		]);
		const out = await relay(splitMidRecord(bytes));
		const bodies = records(out)
			.map((record) => record.data?.body)
			.filter((body) => body?.type === 'error');
		expect(
			bodies.map((body) => ({
				code: body?.error?.code,
				hasOutput: Object.hasOwn(body ?? {}, 'agent_output'),
			})),
		).toEqual([
			{ code: 'site_builder.turn_timeout', hasOutput: false },
			{ code: 'site_builder.failed', hasOutput: false },
			{ code: 'site_builder.agent_failed', hasOutput: true },
		]);
		expect({
			timeout: out.includes('ZZ_TIMEOUT_OUT'),
			failed: out.includes('ZZ_FAILED_OUT'),
		}).toEqual({ timeout: false, failed: false });
		const output = String(bodies[2]?.agent_output);
		expect({ length: output.length, tail: output.endsWith(tail) }).toEqual({
			length: 500,
			tail: true,
		});
	});

	test('a record over MAX_RELAY_RECORD_BYTES ends the stream with stream_lost (never buffered without bound)', async () => {
		const cap = (wire as unknown as { MAX_RELAY_RECORD_BYTES?: number }).MAX_RELAY_RECORD_BYTES;
		expect(typeof cap === 'number' ? 'exported' : 'wire.ts exports no MAX_RELAY_RECORD_BYTES').toBe(
			'exported',
		);
		if (typeof cap !== 'number') return;
		const huge = `data: ${'y'.repeat(cap + 1)}`;
		// NO terminator: the cap is "outgrew before its terminator", and a `\n\n` chunk may
		// reach the relay in the SAME socket read as the second half (the record then
		// completes before the cap is measured) — that made this gate a coalescing lottery.
		const out = await relay([huge.slice(0, cap / 2), huge.slice(cap / 2)]);
		const frame = records(out).find((record) => record.event === 'error');
		expect(frame?.data?.code).toBe('site_builder.stream_lost');
		expect(out.includes('y'.repeat(1024))).toBe(false);
	});
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * 4. parity — the stream map is exactly the stream's vocabulary; retriable is the registry's
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe('G-W1 — parity', () => {
	const map = (wire as unknown as { TURN_EVENT_REASON_CODES?: Readonly<Record<string, string>> })
		.TURN_EVENT_REASON_CODES;

	test('wire.ts TURN_EVENT_REASON_CODES is the pinned contract, key for key', () => {
		expect(map === undefined ? 'wire.ts exports no TURN_EVENT_REASON_CODES' : { ...map }).toEqual({
			...EXPECTED,
		});
	});

	test('the daemon’s stream vocabulary (TURN_ERROR_REASONS) set-equals the map’s keys', async () => {
		const daemon = (await import('../../publication/site_builder/src/drivers/turn_errors.ts').catch(
			(error) => ({
				missing: `drivers/turn_errors.ts cannot be imported: ${String(error)}`,
			}),
		)) as Record<string, unknown>;
		const reasons = daemon.TURN_ERROR_REASONS as readonly string[] | undefined;
		expect(
			reasons === undefined
				? String(daemon.missing ?? 'turn_errors.ts exports no TURN_ERROR_REASONS')
				: [...reasons].sort(),
		).toEqual(Object.keys(EXPECTED).sort());
		const retriable = daemon.TURN_ERROR_RETRIABLE as Readonly<Record<string, boolean>> | undefined;
		for (const reason of Object.keys(EXPECTED)) {
			const code = EXPECTED[reason] as string;
			expect({
				reason,
				daemon: retriable?.[reason] ?? '(none)',
				registry: registry[code]?.retryable ?? '(unregistered)',
			}).toEqual({
				reason,
				daemon: registry[code]?.retryable ?? '(unregistered)',
				registry: registry[code]?.retryable ?? '(unregistered)',
			});
		}
	});

	test('every code the stream maps to is registered, retryable as the design states', () => {
		for (const [code, retryable] of Object.entries(NEW_CODE_RETRYABLE)) {
			expect({ code, retryable: registry[code]?.retryable ?? '(unregistered)' }).toEqual({
				code,
				retryable,
			});
		}
	});
});
