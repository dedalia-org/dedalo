/**
 * publication_hosts WIDGET — panel + root-only actions (phase-3 plan E8–E10).
 *
 * OPERATOR-VISIBLE FAILURES THIS GATES:
 *  - a profile admin rewrites a public host's media gate or rolls back its API
 *    (every action is root-only; the check runs before any module load or agent call);
 *  - a profile admin reads the infrastructure topology from the panel (agent addresses,
 *    the private-dir path, probe paths): a non-root row carries none of them;
 *  - a corrupt registry reads as "no publication hosts" while one is serving
 *    (`registry_invalid`, `hosts: null` — never `[]`);
 *  - a re-provisioned agent (pairing mismatch), or a status body naming another
 *    fingerprint, renders its facts under this engine's heading (the REAL Task 6
 *    buildHostPanelRow is used, so its trust check is exercised, never bypassed);
 *  - one host whose secret file has a widened mode blanks the whole panel;
 *  - the token, the client key or the bundle PEM leaks into the panel payload,
 *    even through an error the agent client raised;
 *  - an agent that dies mid-action leaves a half-written registry or a fake OK;
 *  - a removed host keeps its in-process pairing proof;
 *  - remove_host racing a pair `replace` deletes the NEW pairing's entry (invisible credential);
 *  - set_host_fields accepts a value the REAL registry then refuses, reported as a corrupt
 *    registry (one grammar: the widget runs the registry's own field checks);
 *  - agent prose (a non-hash, a non-release-id) reaches root's toast (E7: log-only).
 *
 * Hermetic: I/O deps are recording fakes (createPublicationHostsWidget); the pure Task 6
 * functions are the real ones. One describe runs set_host_fields through the REAL
 * updateRegistry/validateRegistry in a marker scratch dir. No network, no mock.module.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	FIRST_USE_NEXT,
	loadDefaultSetupDeps,
	type SetupDeps,
} from '../../src/core/area_maintenance/widgets/publication_host_setup.ts';
import {
	addressLabel,
	createPublicationHostsWidget,
	normalizePublicUrl,
	PROBE_PROBLEMS_MAX,
	PROBE_TEXT_MAX,
	PUBLIC_URL_HTTP_NOTICE,
	type PublicationHostsDeps,
	releaseIdOrMalformed,
	widget,
} from '../../src/core/area_maintenance/widgets/publication_hosts.ts';
import { ownershipMark } from '../../src/core/area_maintenance/widgets/support.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import type { AgentStatus, MediaProbe } from '../../src/core/publication_host/agent_client.ts';
import { buildApiLockstepPanel } from '../../src/core/publication_host/api_reconcile.ts';
import type {
	InstallSource,
	PanelDraft,
	StoredDraft,
} from '../../src/core/publication_host/drafts.ts';
import {
	HOST_CHECK_IDS,
	type HostStatusInput,
	buildHostPanelRow as realBuildHostPanelRow,
	registryInvalidCheck,
	statusOutcomeFromError,
} from '../../src/core/publication_host/host_status.ts';
import {
	loadRegistry,
	type PublicationHostRecord,
	RegistryError,
	type RegistryFile,
	saveRegistry,
	updateRegistry,
} from '../../src/core/publication_host/registry.ts';
import {
	type ExpectedRulesOutcome,
	expectedNginxMap as realExpectedNginxMap,
	nginxMapPanel as realNginxMapPanel,
} from '../../src/core/publication_host/rules.ts';
import { defaultHostRuntime } from '../../src/core/publication_host/runtime.ts';
import type { SecretPresenceOutcome } from '../../src/core/publication_host/secrets.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { useScratchPublicationHostsBase } from '../helpers/publication_host_fixtures.ts';

const ROOT: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
const ADMIN: Principal = { userId: 7, isGlobalAdmin: true, isDeveloper: false };

/** Fixture secrets: none of these may ever appear in a payload. */
const TOKEN = 'SECRET-TOKEN-7f3a9c1e5b2d4f6a8c0e2b4d6f8a0c2e4b6d';
const KEY_PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQSECRETKEYBYTESZZ\n-----END PRIVATE KEY-----';
const REGISTRY_PATH = '/scratch/private/publication_hosts.json';

const ACTIONS = [
	'apply_rules',
	'probe',
	'rollback_api',
	'set_host_fields',
	'remove_host',
	'push_apis', // phase 4 (publication_host_push_apis_widget.test.ts gates its behaviour)
	'reconcile_media_copy', // phase 5 (publication_host_media_copy_widget_native.test.ts too)
	'probe_public', // phase 6 (publication_host_probe_native.test.ts gates it against the real stores)
	// "New publication host" (publication_host_setup_native.test.ts gates their behaviour)
	'propose_draft',
	'save_draft',
	'remove_draft',
	'build_kit',
	'download_kit',
	'pair_package',
] as const;

/** The served row keys, pinned: root gets the edit-form fields, a non-root admin no topology. */
const ROOT_ROW_KEYS = [
	'address_label',
	'apis',
	'bun',
	'bundle_present',
	'checks',
	'name',
	'nginx_map',
	'pairing_proved',
	'probe',
	'public_probe',
	'public_url',
	'qualities',
	'rules',
	'served_apis',
	'token_present',
];
const ADMIN_ROW_KEYS = [
	'apis',
	'bun',
	'bundle_present',
	'checks',
	'name',
	'nginx_map',
	'pairing_proved',
	'public_probe',
	'public_url',
	'rules',
	'served_apis',
	'token_present',
];

function record(name: string, over: Partial<PublicationHostRecord> = {}): PublicationHostRecord {
	return {
		name,
		instance: 'test',
		fingerprint: 'a'.repeat(64),
		address: { kind: 'tls', host: '10.20.0.5', port: 8443 },
		public_url: 'https://www.museum.test',
		qualities: null,
		probe: { published: null, unpublished: null },
		paired_at: '2026-10-03T00:00:00.000Z',
		...over,
	};
}

function mediaProbe(over: Partial<MediaProbe> = {}): MediaProbe {
	return {
		mode: 'shared',
		root: '/srv/pub_media',
		present: true,
		read_only: true,
		pub_readable: true,
		web_traversable: true,
		pub_markers: 3,
		problems: [],
		...over,
	};
}

function agentStatus(over: Partial<AgentStatus> = {}): AgentStatus {
	return {
		agent_version: '0.1.0',
		bun_version: '1.4.2',
		platform: 'linux',
		instance_fingerprint: 'a'.repeat(64),
		apis: {
			v1: { current: '7.0.0_a1b2c3d', previous: '7.0.0_9f8e7d6' },
			v2: { current: null, previous: null },
		},
		served_apis: ['v1', 'v2'],
		rules: { server: 'apache', hash: 'b'.repeat(64) },
		media: mediaProbe(),
		disk: { state_root_free_bytes: 1_000_000 },
		...over,
	};
}

const MAP_HASH = 'e'.repeat(64);

/** An nginx host whose http{} map is the provisioned host-wide include. */
function nginxStatus(
	map: AgentStatus['rules']['map'] = MANAGED_MAP,
	over: Partial<AgentStatus> = {},
): AgentStatus {
	return agentStatus({ rules: { server: 'nginx', hash: 'b'.repeat(64), map }, ...over });
}
const MANAGED_MAP = {
	managed: true as const,
	hash: null,
	host_hash: null,
	contributions: 0,
	invalid: 0,
	refused: null,
};

const EXPECTED = {
	server: 'apache' as const,
	text: '# rules\n',
	hash: 'c'.repeat(64),
	dropped: [],
};
/** secretPresenceOutcome for a fully provisioned host. */
const PRESENT: SecretPresenceOutcome = { token_present: true, bundle_present: true, refused: null };

/** A recorded public-URL probe verdict (phase 6). */
const PROBED = {
	state: 'ok' as const,
	at: '2026-10-03T11:58:00.000Z',
	published_status: 200,
	unpublished_status: 404,
	detail: null,
};

const EXPECTED_OUTCOME: ExpectedRulesOutcome = { ok: true, hash: 'c'.repeat(64), dropped: [] };

interface Harness {
	deps: PublicationHostsDeps;
	calls: string[];
	loads: () => number;
	registry: () => RegistryFile;
	rowInputs: HostStatusInput[];
	module: ReturnType<typeof createPublicationHostsWidget>;
}

function harness(
	hosts: PublicationHostRecord[],
	over: Partial<PublicationHostsDeps> = {},
): Harness {
	let file: RegistryFile = { version: 1, hosts };
	let loads = 0;
	const calls: string[] = [];
	const rowInputs: HostStatusInput[] = [];
	const deps: PublicationHostsDeps = {
		registryPath: () => REGISTRY_PATH,
		loadRegistry: () => {
			calls.push('loadRegistry');
			return structuredClone(file);
		},
		updateRegistry: (fn) => {
			calls.push('updateRegistry');
			file = fn(structuredClone(file));
			return file;
		},
		secretPresenceOutcome: () => ({ ...PRESENT }),
		removeHostSecrets: (name) => {
			calls.push(`removeHostSecrets:${name}`);
		},
		forgetPairing: (name) => {
			calls.push(`forgetPairing:${name}`);
		},
		hostStatus: async (name) => {
			calls.push(`hostStatus:${name}`);
			return agentStatus();
		},
		hostMediaProbe: async (name) => {
			calls.push(`hostMediaProbe:${name}`);
			return mediaProbe({ problems: ['pub/ is not readable'] });
		},
		hostApplyRules: async (name, req, actor) => {
			calls.push(`hostApplyRules:${name}:${req.server}:${req.hash}:${actor}`);
			return { hash: req.hash, reloaded: true };
		},
		hostRollbackRelease: async (name, api, actor) => {
			calls.push(`hostRollbackRelease:${name}:${api}:${actor}`);
			return { from: '7.0.0_a1b2c3d', to: '7.0.0_9f8e7d6' };
		},
		hostApplyRulesMap: async (name, req, actor) => {
			calls.push(`hostApplyRulesMap:${name}:${req.hash}:${actor}`);
			return { hash: req.hash, host_hash: req.hash, contributions: 1, reloaded: true };
		},
		expectedNginxMap: (status) => {
			calls.push('expectedNginxMap');
			return realExpectedNginxMap(status) === null ? null : { text: '# map\n', hash: MAP_HASH };
		},
		nginxMapPanel: realNginxMapPanel,
		expectedRulesForHost: () => {
			calls.push('expectedRulesForHost');
			return EXPECTED;
		},
		expectedRulesOutcome: () => {
			calls.push('expectedRulesOutcome');
			return EXPECTED_OUTCOME;
		},
		statusOutcomeFromError,
		buildHostPanelRow: (input) => {
			rowInputs.push(input);
			return realBuildHostPanelRow(input);
		},
		engineQualities: () => ['image/1.5MB', 'image/thumb'],
		filterPublicQualities: (configured) =>
			configured.map((q) => q.replace(/^\/+|\/+$/g, '')).filter((q) => !q.endsWith('/original')),
		engineVersion: () => '7.0.0',
		bunPin: () => '1.4.2',
		loadPanelRuntime: async () => ({ runtime: {}, runtime_invalid: null }),
		buildApiLockstepPanel,
		reconcilePublicationApis: async () => {
			throw new DedaloError('internal.unexpected', { message: 'push_apis is gated elsewhere' });
		},
		pushAnswerWithinMs: () => 5_000,
		mediaCopyRound: async (name) => {
			calls.push(`mediaCopyRound:${name}`);
			return { drift: 0, applied: 0, detail: { hosts: {} } };
		},
		now: () => Date.parse('2026-10-03T12:00:00.000Z'),
		probePublicGate: async (name) => {
			calls.push(`probePublicGate:${name}`);
			return { ...PROBED };
		},
		probeAfterRulesApplied: async (name) => {
			calls.push(`probeAfterRulesApplied:${name}`);
			return { ...PROBED };
		},
		...over,
	};
	const module = createPublicationHostsWidget(async () => {
		loads += 1;
		return deps;
	});
	return { deps, calls, loads: () => loads, registry: () => file, rowInputs, module };
}

async function run(
	h: Harness,
	action: (typeof ACTIONS)[number],
	options: Record<string, unknown>,
	principal: Principal = ROOT,
) {
	const handler = h.module.apiActions?.[action];
	if (handler === undefined) throw new DedaloError('internal.unexpected', { message: action });
	return handler(options, principal);
}

async function panel(h: Harness, principal: Principal = ROOT): Promise<Record<string, unknown>> {
	return (await h.module.getValue?.({}, principal))?.data as Record<string, unknown>;
}

function rows(data: Record<string, unknown>): Record<string, unknown>[] {
	return data.hosts as Record<string, unknown>[];
}

function checkOf(row: Record<string, unknown>, id: string): unknown {
	return (row.checks as { id: string }[]).find((check) => check.id === id);
}

/** The thrown DedaloError's code (a non-DedaloError rejection fails the test). */
async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(DedaloError);
		return (error as DedaloError).code;
	}
	throw new DedaloError('internal.unexpected', { message: 'expected a rejection' });
}

const NO_APIS = { v1: { current: null, previous: null }, v2: { current: null, previous: null } };

describe('registration', () => {
	test('in the total surface and the served catalog, right after site_builder_status', async () => {
		const { ALL_WIDGET_MODULES, WIDGET_MODULES } = await import(
			'../../src/core/area_maintenance/widgets/registry.ts'
		);
		expect(ALL_WIDGET_MODULES.find((m) => m.spec.id === 'publication_hosts')).toBe(widget);
		const ids = WIDGET_MODULES.map((m) => m.spec.id);
		expect(ids[ids.indexOf('site_builder_status') + 1]).toBe('publication_hosts');
	});

	test('spec, lazy get_value, exactly the listed actions, none unbounded, none ownership-marked', () => {
		expect(widget.spec).toEqual({
			id: 'publication_hosts',
			category: 'publication',
			label: { kind: 'label', key: 'publication_hosts' },
		});
		expect(typeof widget.getValue).toBe('function');
		expect(widget.eagerValue).toBeUndefined();
		expect(widget.unboundedActions).toBeUndefined();
		expect(Object.keys(widget.apiActions ?? {})).toEqual([...ACTIONS]);
		for (const action of ACTIONS) {
			// ENGINE_NATIVE in update_ownership_tripwire, never gated()
			expect(ownershipMark(widget.apiActions?.[action] as never), action).toBeUndefined();
		}
	});

	test('a global admin who is not root is refused through the REAL dispatch, every action', async () => {
		const { dispatchWidgetRequest } = await import(
			'../../src/core/area_maintenance/widgets/registry.ts'
		);
		// The production widget wires the REAL registry/secrets: armed on a scratch base, a
		// broken root guard fails here and never reaches the live <private>.
		const scratch = useScratchPublicationHostsBase();
		try {
			saveRegistry({ version: 1, hosts: [record('pub_a')] });
			const before = readFileSync(join(scratch.base, 'publication_hosts.json'), 'utf8');
			for (const action of ACTIONS) {
				const code = await codeOf(
					dispatchWidgetRequest(ADMIN, { model: 'publication_hosts', action }, { name: 'pub_a' }),
				);
				expect(code, action).toBe('perm.denied');
			}
			expect(readFileSync(join(scratch.base, 'publication_hosts.json'), 'utf8')).toBe(before);
		} finally {
			scratch.dispose();
		}
	});
});

describe('get_value (panel)', () => {
	test('root, a paired host: the Task 6 row + the edit-form fields; inputs built as Task 6 defines', async () => {
		const h = harness([record('pub_a')]);
		const data = await panel(h);
		expect(data.registry).toEqual({ state: 'ok', reason: null, check: null });
		expect(data.registry_path).toBe(REGISTRY_PATH);
		expect(data.engine_qualities).toEqual(['image/1.5MB', 'image/thumb']);
		expect(data.is_root).toBe(true);
		const [row] = rows(data);
		expect(Object.keys(row ?? {}).sort()).toEqual(ROOT_ROW_KEYS);
		expect(row).toMatchObject({
			name: 'pub_a',
			address_label: '10.20.0.5:8443',
			public_url: 'https://www.museum.test',
			rules: { expected: 'c'.repeat(64), reported: 'b'.repeat(64) },
			bun: { expected: '1.4.2', reported: '1.4.2' },
			apis: {
				v1: { current: '7.0.0_a1b2c3d', previous: '7.0.0_9f8e7d6' },
				v2: { current: null, previous: null },
			},
			token_present: true,
			bundle_present: true,
			pairing_proved: true,
			qualities: null,
			probe: { published: null, unpublished: null },
		});
		// the fixed list; the phase-5 decorator adds NO media_copy check: the agent says
		// `shared` and the host holds nothing (media_copy_status.ts liveMediaMode); the
		// phase-6 decorator adds public_gate LAST on every row (never probed here)
		expect(((row?.checks ?? []) as { id: string }[]).map((c) => c.id)).toEqual([
			...HOST_CHECK_IDS,
			'public_gate',
		]);
		expect(checkOf(row ?? {}, 'public_gate')).toEqual({
			id: 'public_gate',
			state: 'unknown',
			detail: 'never_probed',
		});
		expect(row?.public_probe).toMatchObject({ state: 'unknown', at: null });
		// a COPY-mode agent with no runtime row yet → media_copy unknown
		const copyHarness = harness([record('pub_a')], {
			hostStatus: async () =>
				agentStatus({ media: mediaProbe({ mode: 'copy', root: '/srv/copy', read_only: false }) }),
		});
		const [copyRow] = rows(await panel(copyHarness));
		expect(checkOf(copyRow ?? {}, 'media_copy')).toEqual({
			id: 'media_copy',
			state: 'unknown',
			detail: 'not_reconciled',
		});
		expect(h.rowInputs).toHaveLength(1);
		expect(h.rowInputs[0]?.status).toEqual({ ok: true, status: agentStatus() });
		expect(h.rowInputs[0]?.expected).toEqual(EXPECTED_OUTCOME);
		expect(h.rowInputs[0]?.engineVersion).toBe('7.0.0');
		expect(h.rowInputs[0]?.bunPin).toBe('1.4.2');
		// the Task 1 outcome reaches Task 6 UNCHANGED (refused included)
		expect(h.rowInputs[0]?.secrets).toEqual(PRESENT);
	});

	test('a pairing mismatch: the code reaches Task 6, no expectation computed, no agent fact', async () => {
		const h = harness([record('pub_a')], {
			hostStatus: async () => {
				throw new DedaloError('publication_host.pairing_mismatch');
			},
		});
		const [row] = rows(await panel(h));
		expect(h.rowInputs[0]?.status).toEqual({
			ok: false,
			code: 'publication_host.pairing_mismatch',
		});
		expect(h.rowInputs[0]?.expected).toBeNull();
		expect(h.calls).not.toContain('expectedRulesOutcome');
		expect(row?.pairing_proved).toBe(false);
		expect(row?.rules).toEqual({ expected: null, reported: null });
		expect(row?.apis).toEqual(NO_APIS);
	});

	test('a status body naming another fingerprint is NOT rendered as this host (Task 6 trust check)', async () => {
		const h = harness([record('pub_a')], {
			hostStatus: async () => agentStatus({ instance_fingerprint: 'f'.repeat(64) }),
		});
		const [row] = rows(await panel(h));
		expect(row?.pairing_proved).toBe(false);
		expect(checkOf(row ?? {}, 'pairing')).toEqual({
			id: 'pairing',
			state: 'blocked',
			detail: 'status_fingerprint',
		});
		expect(row?.rules).toEqual({ expected: null, reported: null });
		expect(row?.apis).toEqual(NO_APIS);
	});

	test('a host with no media (mode none): the refusal outcome reaches Task 6, no expected hash, rules not applicable', async () => {
		const h = harness([record('pub_a')], {
			hostStatus: async () =>
				agentStatus({ media: mediaProbe({ mode: 'none', root: null, read_only: null }) }),
			expectedRulesOutcome: () => ({ ok: false, reason: 'mode' }),
		});
		const [row] = rows(await panel(h));
		expect(h.rowInputs[0]?.expected).toEqual({ ok: false, reason: 'mode' });
		expect((row?.rules as { expected: unknown }).expected).toBeNull();
		expect(checkOf(row ?? {}, 'rules_hash')).toEqual({
			id: 'rules_hash',
			state: 'ok',
			detail: 'not_applicable',
		});
	});

	test('a non-root global admin: readable, but no address, no private path, no edit fields', async () => {
		const h = harness([record('pub_a', { qualities: ['image/thumb'] })]);
		const data = await panel(h, ADMIN);
		expect(data.is_root).toBe(false);
		expect(data.registry_path).toBeNull();
		const [row] = rows(data);
		expect(Object.keys(row ?? {}).sort()).toEqual(ADMIN_ROW_KEYS);
		expect(row?.pairing_proved).toBe(true);
		const serialized = JSON.stringify(data);
		expect(serialized).not.toContain('10.20.0.5');
		expect(serialized).not.toContain(REGISTRY_PATH);
	});

	test('a refused secret blocks ONE host (reason shown, not dialled); the others still render', async () => {
		const refused: SecretPresenceOutcome = {
			token_present: false,
			bundle_present: false,
			refused: 'bad_mode',
		};
		const h = harness([record('pub_a'), record('pub_b')], {
			secretPresenceOutcome: (name) => (name === 'pub_a' ? { ...refused } : { ...PRESENT }),
		});
		const [a, b] = rows(await panel(h));
		expect(h.calls).not.toContain('hostStatus:pub_a');
		expect(h.calls).toContain('hostStatus:pub_b');
		expect(h.rowInputs[0]?.status).toEqual({ ok: false, code: 'publication_host.unconfigured' });
		// passed to Task 6 as-is: the widget never hand-patches a check
		expect(h.rowInputs[0]?.secrets).toEqual(refused);
		expect(a?.token_present).toBe(false);
		expect(a?.bundle_present).toBe(false);
		expect(a?.pairing_proved).toBe(false);
		expect(checkOf(a ?? {}, 'secrets')).toEqual({
			id: 'secrets',
			state: 'blocked',
			detail: 'bad_mode',
		});
		expect(b?.pairing_proved).toBe(true);
	});

	test('a refusal is never hidden by present flags: still not dialled, still blocked', async () => {
		const h = harness([record('pub_a')], {
			secretPresenceOutcome: () => ({
				token_present: true,
				bundle_present: true,
				refused: 'bad_bundle',
			}),
		});
		const [a] = rows(await panel(h));
		expect(h.calls).not.toContain('hostStatus:pub_a');
		expect(checkOf(a ?? {}, 'secrets')).toEqual({
			id: 'secrets',
			state: 'blocked',
			detail: 'bad_bundle',
		});
	});

	test('the required secrets decide the dial: a TLS host needs the bundle, a unix host does not', async () => {
		const tokenOnly: SecretPresenceOutcome = {
			token_present: true,
			bundle_present: false,
			refused: null,
		};
		const unix = record('pub_u', {
			address: { kind: 'unix', socket: '/run/dedalo-pubhost/agent.sock' },
		});
		const h = harness([record('pub_t'), unix], { secretPresenceOutcome: () => ({ ...tokenOnly }) });
		const [t, u] = rows(await panel(h));
		expect(h.calls).not.toContain('hostStatus:pub_t');
		expect(h.calls).toContain('hostStatus:pub_u');
		expect(checkOf(t ?? {}, 'secrets')).toEqual({
			id: 'secrets',
			state: 'blocked',
			detail: 'engine_bundle',
		});
		expect(u?.address_label).toBe('unix:/run/dedalo-pubhost/agent.sock');
		expect(checkOf(u ?? {}, 'secrets')).toEqual({ id: 'secrets', state: 'ok' });
		expect(u?.pairing_proved).toBe(true);
	});

	test('a unix-socket host is labelled as one', () => {
		expect(addressLabel({ kind: 'unix', socket: '/run/dedalo-pubhost/agent.sock' })).toBe(
			'unix:/run/dedalo-pubhost/agent.sock',
		);
		expect(addressLabel({ kind: 'tls', host: 'pub.museum.test', port: 9443 })).toBe(
			'pub.museum.test:9443',
		);
	});

	test('a corrupt registry is LOUD: registry_invalid, hosts null (never []), no agent dialled', async () => {
		const h = harness([record('pub_a')], {
			loadRegistry: () => {
				throw new RegistryError('invalid_json', 'Unexpected token } in JSON');
			},
		});
		const data = await panel(h);
		expect(data.registry).toEqual({
			state: 'registry_invalid',
			reason: 'invalid_json',
			check: registryInvalidCheck('invalid_json'),
		});
		expect((data.registry as { check: unknown }).check).toEqual({
			id: 'registry',
			state: 'blocked',
			detail: 'invalid_json',
		});
		expect(data.hosts).toBeNull();
		expect(h.calls.some((c) => c.startsWith('hostStatus'))).toBe(false);
	});

	test('every registry fault on the panel read is registry_invalid; a held lock is busy, never "repair"', async () => {
		for (const reason of [
			'unreadable',
			'invalid_json',
			'invalid_shape',
			'duplicate_name',
		] as const) {
			const h = harness([], {
				loadRegistry: () => {
					throw new RegistryError(reason, 'x');
				},
			});
			expect(((await panel(h)).registry as { state: string }).state, reason).toBe(
				'registry_invalid',
			);
		}
		// loadRegistry takes no lock (only writes do), so this cannot happen in production;
		// if it ever did, the panel must not tell root to repair a file that is only busy.
		const locked = harness([], {
			loadRegistry: () => {
				throw new RegistryError('locked', 'held');
			},
		});
		expect(await codeOf(locked.module.getValue?.({}, ROOT) as Promise<unknown>)).toBe(
			'publication_host.busy',
		);
	});

	test('an unexpected (untyped) registry failure is not swallowed', async () => {
		const h = harness([], {
			loadRegistry: () => {
				throw new TypeError('engine bug');
			},
		});
		await expect(h.module.getValue?.({}, ROOT) as Promise<unknown>).rejects.toThrow('engine bug');
	});

	test('NO SECRET in the payload, even when the failures carry them', async () => {
		const h = harness([record('pub_a'), record('pub_b')], {
			hostStatus: async (name) => {
				if (name === 'pub_a') {
					throw new DedaloError('publication_host.auth', {
						message: `bearer ${TOKEN} refused`,
						details: { token: TOKEN },
						cause: new Error(KEY_PEM),
					});
				}
				return agentStatus();
			},
			expectedRulesOutcome: () => {
				throw new Error(`render failed near ${KEY_PEM} ${TOKEN}`);
			},
		});
		const serialized = JSON.stringify(await h.module.getValue?.({}, ROOT));
		expect(serialized).not.toContain(TOKEN);
		expect(serialized).not.toContain('PRIVATE KEY');
		expect(serialized).not.toContain('SECRETKEYBYTES');
		expect(h.rowInputs.map((input) => input.status.ok)).toEqual([false, true]);
		expect(h.rowInputs[0]?.status).toEqual({ ok: false, code: 'publication_host.auth' });
		expect(h.rowInputs[1]?.expected).toBeNull();
	});
});

describe('root-only actions', () => {
	test('a non-root global admin is refused BEFORE any module load or agent call', async () => {
		for (const action of ACTIONS) {
			const h = harness([record('pub_a')]);
			const code = await codeOf(run(h, action, { name: 'pub_a', api: 'v2' }, ADMIN));
			expect(code, action).toBe('perm.denied');
			expect(h.loads(), action).toBe(0);
			expect(h.calls, action).toEqual([]);
		}
	});

	test('an invalid host name is refused before any module load', async () => {
		// propose_draft takes no name; save_draft names a bad one as a draft field
		// (publication_host_setup_native.test.ts)
		for (const action of ACTIONS.filter((a) => a !== 'propose_draft' && a !== 'save_draft')) {
			const h = harness([record('pub_a')]);
			// push_apis names its hosts as a list (`hosts`), every other action one `name`
			const bad = action === 'push_apis' ? { hosts: ['../etc'] } : { name: '../etc' };
			const code = await codeOf(run(h, action, bad));
			expect(code, action).toBe('maintenance.action_refused');
			expect(h.loads(), action).toBe(0);
		}
	});

	test('an unknown host is refused with no agent call', async () => {
		for (const action of [
			'apply_rules',
			'probe',
			'rollback_api',
			'remove_host',
			'reconcile_media_copy',
			'probe_public',
		] as const) {
			const h = harness([record('pub_a')]);
			const code = await codeOf(run(h, action, { name: 'pub_z', api: 'v1' }));
			expect(code, action).toBe('maintenance.action_refused');
			expect(h.calls, action).toEqual(['loadRegistry']);
		}
	});

	test('a corrupt registry fails the action typed (wire.ts registryError), with no agent call', async () => {
		const h = harness([], {
			loadRegistry: () => {
				throw new RegistryError('invalid_shape', 'hosts[0].address missing');
			},
		});
		expect(await codeOf(run(h, 'apply_rules', { name: 'pub_a' }))).toBe(
			'publication_host.registry_invalid',
		);
		expect(h.calls).toEqual([]);
	});

	test('a held registry lock is busy, and a write refused by it changes nothing', async () => {
		const h = harness([record('pub_a')], {
			updateRegistry: () => {
				throw new RegistryError('locked', 'held by another writer');
			},
		});
		expect(await codeOf(run(h, 'set_host_fields', { name: 'pub_a', public_url: null }))).toBe(
			'publication_host.busy',
		);
		expect(h.registry().hosts).toEqual([record('pub_a')]);
	});

	test('an untyped registry failure in an action is not converted', async () => {
		const h = harness([], {
			loadRegistry: () => {
				throw new TypeError('engine bug');
			},
		});
		await expect(run(h, 'probe', { name: 'pub_a' })).rejects.toThrow(TypeError);
	});
});

describe('reconcile_media_copy (phase 5)', () => {
	const report = (hosts: Record<string, unknown>, drift = 3, applied = 3) => ({
		drift,
		applied,
		detail: { hosts },
	});

	test('runs the media_copy reconcile for THAT host only, answers the report', async () => {
		const h = harness([record('pub_a'), record('pub_b')], {
			mediaCopyRound: async (name) => {
				h.calls.push(`mediaCopyRound:${name}`);
				return report({ [name]: { takes_copy: true, error: null } });
			},
		});
		const response = await run(h, 'reconcile_media_copy', { name: 'pub_a' });
		expect(h.calls).toEqual(['loadRegistry', 'mediaCopyRound:pub_a']);
		expect(response.data).toBe(true);
		expect(response.msg).toBe(
			"'pub_a': drift 3, applied 3. The panel shows what is still pending.",
		);
		expect((response.extend as { running: boolean }).running).toBe(false);
	});

	test('a host that is not a copy host is an OK with its own sentence', async () => {
		const h = harness([record('pub_a')], {
			mediaCopyRound: async () => report({ pub_a: { takes_copy: false, error: null } }, 0, 0),
		});
		const response = await run(h, 'reconcile_media_copy', { name: 'pub_a' });
		expect(response.data).toBe(true);
		expect(response.msg).toContain('does not take a media copy');
	});

	test("the host's round failed → maintenance.action_failed naming the code, never an OK", async () => {
		const h = harness([record('pub_a')], {
			mediaCopyRound: async () =>
				report({ pub_a: { takes_copy: true, error: 'publication_host.unreachable' } }, 1, 0),
		});
		const thrown = await run(h, 'reconcile_media_copy', { name: 'pub_a' }).catch((e) => e);
		expect(thrown).toBeInstanceOf(DedaloError);
		expect((thrown as DedaloError).code).toBe('maintenance.action_failed');
		expect((thrown as DedaloError).publicMessage).toContain('publication_host.unreachable');
	});

	test('a round still going past the bounded wait answers running (data null), never a cut connection', async () => {
		const h = harness([record('pub_a')], {
			pushAnswerWithinMs: () => 20,
			mediaCopyRound: () => new Promise(() => {}),
		});
		const response = await run(h, 'reconcile_media_copy', { name: 'pub_a' });
		expect(response.data).toBeNull();
		expect(response.extend).toEqual({ report: null, running: true });
	});

	test('get_value: a runtime deletion unverified past one period reads blocked on that row', async () => {
		const runtime = {
			pub_a: {
				...defaultHostRuntime(),
				media_copy: {
					...defaultHostRuntime().media_copy,
					state: 'pending' as const,
					present: 1,
					pending_deletions: [{ path: 'a', since: '2026-10-03T11:00:00.000Z' }],
				},
			},
		};
		const h = harness([record('pub_a')], {
			loadPanelRuntime: async () => ({ runtime, runtime_invalid: null }),
		});
		const [row] = rows(await panel(h));
		expect(checkOf(row ?? {}, 'media_copy')).toEqual({
			id: 'media_copy',
			state: 'blocked',
			detail: 'unverified_deletions:1',
		});
	});
});

describe('apply_rules', () => {
	test('status → expected rules → rules.apply with the root actor; the dropped list is reported', async () => {
		const h = harness([record('pub_a')], {
			expectedRulesForHost: () => ({ ...EXPECTED, dropped: ['image/original'] }),
		});
		const response = await run(h, 'apply_rules', { name: 'pub_a' });
		expect(h.calls).toEqual([
			'loadRegistry',
			'hostStatus:pub_a',
			`hostApplyRules:pub_a:apache:${'c'.repeat(64)}:dedalo_user:-1`,
			'probeAfterRulesApplied:pub_a',
		]);
		expect(response.data).toEqual({
			host: 'pub_a',
			server: 'apache',
			hash: 'c'.repeat(64),
			dropped: ['image/original'],
			map: { state: 'not_applicable' },
		});
		expect(response.msg).toBe(
			`OK. Media rules applied on 'pub_a' (apache, ${'c'.repeat(12)}). Not public, left out: image/original.`,
		);
		// phase 6: the gate is proven through the public URL right after the apply
		expect(response.extend).toEqual({ probe: PROBED });
	});

	test('a copy-mode host gets the same profile applied (phase 5: its copy root is gated)', async () => {
		const h = harness([record('pub_a')], {
			hostStatus: async () =>
				agentStatus({ media: mediaProbe({ mode: 'copy', root: '/srv/copy', read_only: false }) }),
		});
		await run(h, 'apply_rules', { name: 'pub_a' });
		expect(h.calls.some((c) => c.startsWith('hostApplyRules:pub_a:'))).toBe(true);
	});

	test('pairing mismatch: the typed code, nothing applied', async () => {
		const h = harness([record('pub_a')], {
			hostStatus: async () => {
				throw new DedaloError('publication_host.pairing_mismatch');
			},
		});
		expect(await codeOf(run(h, 'apply_rules', { name: 'pub_a' }))).toBe(
			'publication_host.pairing_mismatch',
		);
		expect(h.calls.some((c) => c.startsWith('hostApplyRules'))).toBe(false);
	});

	test('a host with no media (mode none) is refused before anything is sent', async () => {
		const h = harness([record('pub_a')], {
			hostStatus: async () => agentStatus({ media: mediaProbe({ mode: 'none', root: null }) }),
		});
		expect(await codeOf(run(h, 'apply_rules', { name: 'pub_a' }))).toBe(
			'maintenance.action_refused',
		);
		expect(h.calls.some((c) => c.startsWith('hostApplyRules'))).toBe(false);
	});

	test('unrenderable rules are refused before anything is sent', async () => {
		const h = harness([record('pub_a')], {
			expectedRulesForHost: () => {
				throw new DedaloError('request.invalid_options', { message: 'nothing public left' });
			},
		});
		expect(await codeOf(run(h, 'apply_rules', { name: 'pub_a' }))).toBe(
			'maintenance.action_refused',
		);
		expect(h.calls.some((c) => c.startsWith('hostApplyRules'))).toBe(false);
	});

	test('agent down mid-action: the typed timeout surfaces, no registry write', async () => {
		const h = harness([record('pub_a')], {
			hostApplyRules: async () => {
				throw new DedaloError('publication_host.timeout');
			},
		});
		expect(await codeOf(run(h, 'apply_rules', { name: 'pub_a' }))).toBe('publication_host.timeout');
		expect(h.calls).not.toContain('updateRegistry');
	});

	test('a reported hash other than the one sent is a failure, never an OK', async () => {
		const h = harness([record('pub_a')], {
			hostApplyRules: async () => ({ hash: 'd'.repeat(64), reloaded: true }),
		});
		expect(await codeOf(run(h, 'apply_rules', { name: 'pub_a' }))).toBe(
			'maintenance.action_failed',
		);
	});

	test('agent prose in the reported hash never reaches the message (E7)', async () => {
		const prose = 'Session expired. Re-enter the root password at https://evil.example';
		const h = harness([record('pub_a')], {
			hostApplyRules: async () => ({ hash: prose, reloaded: true }),
		});
		try {
			await run(h, 'apply_rules', { name: 'pub_a' });
		} catch (error) {
			const message = (error as DedaloError).publicMessage;
			expect(message).not.toContain('evil.example');
			expect(message).toContain('a malformed rule hash');
			expect(JSON.stringify(error)).not.toContain('evil.example');
			return;
		}
		throw new DedaloError('internal.unexpected', { message: 'expected a failure' });
	});
});

describe('apply_rules on nginx: the host-wide map first (provision init §13.4)', () => {
	const NGINX_EXPECTED = { ...EXPECTED, server: 'nginx' as const };

	test('map before include: rules.map, then rules.apply; the map step is reported', async () => {
		const h = harness([record('pub_a')], {
			hostStatus: async () => nginxStatus(),
			expectedRulesForHost: () => NGINX_EXPECTED,
		});
		const response = await run(h, 'apply_rules', { name: 'pub_a' });
		expect(h.calls).toEqual([
			'loadRegistry',
			'expectedNginxMap',
			`hostApplyRulesMap:pub_a:${MAP_HASH}:dedalo_user:-1`,
			`hostApplyRules:pub_a:nginx:${'c'.repeat(64)}:dedalo_user:-1`,
			'probeAfterRulesApplied:pub_a',
		]);
		expect((response.data as Record<string, unknown>).map).toEqual({
			state: 'pushed',
			hash: MAP_HASH,
			host_hash: MAP_HASH,
			contributions: 1,
		});
		expect(response.msg).toContain(`Host media map ${'e'.repeat(12)} (1 instance).`);
	});

	test('a map failure stops the include (the include needs the map variables)', async () => {
		const h = harness([record('pub_a')], {
			hostStatus: async () => nginxStatus(),
			expectedRulesForHost: () => NGINX_EXPECTED,
			hostApplyRulesMap: async () => {
				throw new DedaloError('publication_host.busy');
			},
		});
		expect(await codeOf(run(h, 'apply_rules', { name: 'pub_a' }))).toBe('publication_host.busy');
		expect(h.calls.some((c) => c.startsWith('hostApplyRules:'))).toBe(false);
	});

	test('a map answer naming another hash is a failure; the include is not sent', async () => {
		const h = harness([record('pub_a')], {
			hostStatus: async () => nginxStatus(),
			expectedRulesForHost: () => NGINX_EXPECTED,
			hostApplyRulesMap: async () => ({
				hash: 'f'.repeat(64),
				host_hash: 'f'.repeat(64),
				contributions: 1,
				reloaded: true,
			}),
		});
		expect(await codeOf(run(h, 'apply_rules', { name: 'pub_a' }))).toBe(
			'maintenance.action_failed',
		);
		expect(h.calls.some((c) => c.startsWith('hostApplyRules:'))).toBe(false);
	});

	test('an agent without rules.map predates the host map: refused, nothing sent', async () => {
		const h = harness([record('pub_a')], {
			hostStatus: async () => agentStatus({ rules: { server: 'nginx', hash: null } }),
			expectedRulesForHost: () => NGINX_EXPECTED,
		});
		const error = await run(h, 'apply_rules', { name: 'pub_a' }).catch(
			(e: unknown) => e as DedaloError,
		);
		expect((error as DedaloError).code).toBe('maintenance.action_refused');
		expect((error as DedaloError).publicMessage).toContain(
			'predates the host-wide nginx media map',
		);
		expect(h.calls.some((c) => c.startsWith('hostApply'))).toBe(false);
	});

	test('managed:false skips the map; the include goes as before', async () => {
		const h = harness([record('pub_a')], {
			hostStatus: async () => nginxStatus({ managed: false }),
			expectedRulesForHost: () => NGINX_EXPECTED,
		});
		const response = await run(h, 'apply_rules', { name: 'pub_a' });
		expect(h.calls.some((c) => c.startsWith('hostApplyRulesMap'))).toBe(false);
		expect(h.calls.some((c) => c.startsWith('hostApplyRules:pub_a:nginx'))).toBe(true);
		expect((response.data as Record<string, unknown>).map).toEqual({ state: 'not_applicable' });
	});

	test('a map the agent already reports loaded is not re-pushed', async () => {
		const h = harness([record('pub_a')], {
			hostStatus: async () =>
				nginxStatus({ ...MANAGED_MAP, hash: MAP_HASH, host_hash: MAP_HASH, contributions: 1 }),
			expectedRulesForHost: () => NGINX_EXPECTED,
		});
		const response = await run(h, 'apply_rules', { name: 'pub_a' });
		expect(h.calls.some((c) => c.startsWith('hostApplyRulesMap'))).toBe(false);
		expect((response.data as Record<string, unknown>).map).toEqual({
			state: 'current',
			hash: MAP_HASH,
		});
		expect(response.msg).toContain('Host media map already current.');
	});
});

describe('the row carries the host map state', () => {
	test('nginx managed: expected vs applied, drift; apache: null; an unproved status: null', async () => {
		const h = harness([record('pub_a'), record('pub_b')], {
			hostStatus: async (name) => (name === 'pub_a' ? nginxStatus() : agentStatus()),
		});
		const [a, b] = rows(await panel(h));
		expect(a?.nginx_map).toMatchObject({
			managed: true,
			applied: null,
			drift: true,
			agent_outdated: false,
		});
		expect((a?.nginx_map as { expected: string }).expected).toMatch(/^[0-9a-f]{64}$/);
		expect(b?.nginx_map).toBeNull();
		const down = harness([record('pub_a')], {
			hostStatus: async () => {
				throw new DedaloError('publication_host.unreachable');
			},
		});
		expect(rows(await panel(down))[0]?.nginx_map).toBeNull();
	});

	test('a non-root admin sees the map state too (no topology in it); an engine fault reads null', async () => {
		const h = harness([record('pub_a')], {
			hostStatus: async () => nginxStatus({ managed: false }),
		});
		expect(rows(await panel(h, ADMIN))[0]?.nginx_map).toMatchObject({
			managed: false,
			drift: false,
		});
		// the host-wide facts (other instances' contributions) stay below root
		const shared = harness([record('pub_a')], {
			hostStatus: async () =>
				nginxStatus({ ...MANAGED_MAP, hash: MAP_HASH, host_hash: MAP_HASH, contributions: 3 }),
		});
		const adminMap = rows(await panel(shared, ADMIN))[0]?.nginx_map as Record<string, unknown>;
		expect(adminMap).toMatchObject({ managed: true, applied: MAP_HASH });
		for (const key of ['host_hash', 'contributions', 'invalid'])
			expect(Object.hasOwn(adminMap, key)).toBe(false);
		expect(rows(await panel(shared))[0]?.nginx_map).toMatchObject({
			host_hash: MAP_HASH,
			contributions: 3,
		});
		const broken = harness([record('pub_a')], {
			hostStatus: async () => nginxStatus(),
			nginxMapPanel: () => {
				throw new Error('engine bug');
			},
		});
		expect(rows(await panel(broken))[0]?.nginx_map).toBeNull();
	});

	test('B3: the map state is a CHECK on the row (counted like every red line), absent when the map does not apply', async () => {
		const mapCheck = (row: Record<string, unknown> | undefined) =>
			(row?.checks as { id: string; state: string; detail?: string }[]).filter(
				(c) => c.id === 'nginx_map',
			);
		const h = harness([record('pub_a'), record('pub_b')], {
			hostStatus: async (name) => (name === 'pub_a' ? nginxStatus() : agentStatus()),
		});
		const [a, b] = rows(await panel(h));
		expect(mapCheck(a)).toEqual([{ id: 'nginx_map', state: 'blocked', detail: 'none' }]);
		expect(mapCheck(b)).toEqual([]);
		// the fixed list stays first, the decorator right after it (before media_copy / public_gate)
		const ids = (a?.checks as { id: string }[]).map((c) => c.id);
		expect(ids.indexOf('nginx_map')).toBe(ids.indexOf('api_v2') + 1);
		// the engine's own expected hash, loaded: ok (non-root too)
		const expected = (a?.nginx_map as { expected: string }).expected;
		const loaded = harness([record('pub_a')], {
			hostStatus: async () =>
				nginxStatus({ ...MANAGED_MAP, hash: expected, host_hash: MAP_HASH, contributions: 2 }),
		});
		expect(mapCheck(rows(await panel(loaded, ADMIN))[0])).toEqual([
			{ id: 'nginx_map', state: 'ok', detail: expected.slice(0, 12) },
		]);
		const drifted = harness([record('pub_a')], {
			hostStatus: async () =>
				nginxStatus({ ...MANAGED_MAP, hash: MAP_HASH, host_hash: MAP_HASH, contributions: 1 }),
		});
		expect(mapCheck(rows(await panel(drifted))[0])).toEqual([
			{ id: 'nginx_map', state: 'blocked', detail: 'drift' },
		]);
		const hand = harness([record('pub_a')], {
			hostStatus: async () => nginxStatus({ managed: false }),
		});
		expect(mapCheck(rows(await panel(hand))[0])).toEqual([
			{ id: 'nginx_map', state: 'ok', detail: 'unmanaged' },
		]);
	});
});

describe('probe and rollback_api', () => {
	test('probe returns the agent probe under data.probe and counts its problems', async () => {
		const h = harness([record('pub_a')]);
		const response = await run(h, 'probe', { name: 'pub_a' });
		expect(response.data).toEqual({
			host: 'pub_a',
			probe: mediaProbe({ problems: ['pub/ is not readable'] }),
		});
		expect(response.msg).toBe("Media probe on 'pub_a' found 1 problem(s).");
	});

	test('probe carries web_traversable as the agent measured it (false = a dark dir, every file 404s)', async () => {
		for (const web_traversable of [true, false, null]) {
			const h = harness([record('pub_a')], {
				hostMediaProbe: async () => mediaProbe({ mode: 'copy', web_traversable }),
			});
			const response = await run(h, 'probe', { name: 'pub_a' });
			const bound = (response.data as { probe: MediaProbe }).probe;
			expect(bound.web_traversable).toBe(web_traversable);
		}
	});

	test('probe output is BOUNDED: known fields only, problems capped in count and length, printable only, a bad root is malformed', async () => {
		const hostile = {
			...mediaProbe({
				root: '/srv/pub\n[publication_hosts] FORGED',
				problems: Array.from(
					{ length: 40 },
					(_, i) => `p${i}\u202e\u0007${'x'.repeat(5000)}\r\nFORGED`,
				),
			}),
			injected: '<img src=x onerror=alert(1)>',
		} as MediaProbe;
		const h = harness([record('pub_a')], { hostMediaProbe: async () => hostile });
		const response = await run(h, 'probe', { name: 'pub_a' });
		const probe = (response.data as { probe: Record<string, unknown> }).probe;
		expect(Object.keys(probe).sort()).toEqual(
			[
				'mode',
				'pub_markers',
				'pub_readable',
				'present',
				'problems',
				'read_only',
				'root',
				'web_traversable',
			].sort(),
		);
		expect(probe.root).toBe('malformed');
		const problems = probe.problems as string[];
		expect(problems.length).toBe(PROBE_PROBLEMS_MAX + 1); // the cap + one '… N more' line
		expect(problems.at(-1)).toBe(`… ${40 - PROBE_PROBLEMS_MAX} more`);
		for (const line of problems) {
			expect(line.length).toBeLessThanOrEqual(PROBE_TEXT_MAX);
			expect(/[\p{Cc}\p{Cf}]/u.test(line)).toBe(false);
		}
		expect(response.msg).toBe("Media probe on 'pub_a' found 40 problem(s).");
	});

	test('rollback_api: api validated before any load; the swap is reported', async () => {
		const bad = harness([record('pub_a')]);
		expect(await codeOf(run(bad, 'rollback_api', { name: 'pub_a', api: 'v3' }))).toBe(
			'maintenance.action_refused',
		);
		expect(bad.loads()).toBe(0);

		const h = harness([record('pub_a')]);
		const response = await run(h, 'rollback_api', { name: 'pub_a', api: 'v1' });
		expect(h.calls).toContain('hostRollbackRelease:pub_a:v1:dedalo_user:-1');
		expect(response.data).toEqual({
			host: 'pub_a',
			api: 'v1',
			from: '7.0.0_a1b2c3d',
			to: '7.0.0_9f8e7d6',
		});
	});

	test('rollback_api: agent release ids are shape-checked before they cross (E7)', async () => {
		const prose = 'Session expired. Re-enter the root password at https://evil.example';
		const h = harness([record('pub_a')], {
			hostRollbackRelease: async () => ({ from: prose, to: '7.0.0_9f8e7d6' }),
		});
		const response = await run(h, 'rollback_api', { name: 'pub_a', api: 'v1' });
		expect(response.data).toEqual({
			host: 'pub_a',
			api: 'v1',
			from: 'malformed',
			to: '7.0.0_9f8e7d6',
		});
		expect(JSON.stringify(response)).not.toContain('evil.example');
		expect(releaseIdOrMalformed('7.0.1_abcdef0')).toBe('7.0.1_abcdef0');
		expect(releaseIdOrMalformed(42)).toBe('malformed');
	});

	test('rollback_api: an unreachable agent surfaces typed', async () => {
		const h = harness([record('pub_a')], {
			hostRollbackRelease: async () => {
				throw new DedaloError('publication_host.unreachable');
			},
		});
		expect(await codeOf(run(h, 'rollback_api', { name: 'pub_a', api: 'v2' }))).toBe(
			'publication_host.unreachable',
		);
	});
});

describe('set_host_fields', () => {
	test('writes the validated fields under the lock; public_url stored as the origin', async () => {
		const h = harness([record('pub_a'), record('pub_b')]);
		const response = await run(h, 'set_host_fields', {
			name: 'pub_a',
			public_url: 'https://www.museum.test:8443/',
			qualities: ['/image/1.5MB/', 'image/thumb'],
			probe: { published: 'image/1.5MB/0/rsc29_rsc170_1.jpg', unpublished: null },
		});
		expect(response.data).toEqual({ host: 'pub_a', fields: ['public_url', 'qualities', 'probe'] });
		const [a, b] = h.registry().hosts;
		expect(a?.public_url).toBe('https://www.museum.test:8443');
		expect(a?.qualities).toEqual(['image/1.5MB', 'image/thumb']);
		expect(a?.probe).toEqual({ published: 'image/1.5MB/0/rsc29_rsc170_1.jpg', unpublished: null });
		expect(b).toEqual(record('pub_b'));
	});

	test('an http public_url is stored, NOT refused, and the answer carries the notice (§7)', async () => {
		const h = harness([record('pub_a')]);
		const response = await run(h, 'set_host_fields', {
			name: 'pub_a',
			public_url: 'http://intranet.museum.test',
		});
		expect(h.registry().hosts[0]?.public_url).toBe('http://intranet.museum.test');
		expect(response.msg).toBe(`OK. Host 'pub_a' updated: public_url. ${PUBLIC_URL_HTTP_NOTICE}`);
		expect(PUBLIC_URL_HTTP_NOTICE).toContain('https://');

		const https = await run(h, 'set_host_fields', {
			name: 'pub_a',
			public_url: 'https://www.museum.test',
		});
		expect(https.msg).toBe(`OK. Host 'pub_a' updated: public_url.`);
		// No notice for a save that does not set the public URL, whatever is stored.
		const other = await run(h, 'set_host_fields', { name: 'pub_a', qualities: null });
		expect(other.msg).not.toContain('Notice');
	});

	test('null resets a field (qualities null = follow the engine)', async () => {
		const h = harness([record('pub_a', { qualities: ['image/thumb'] })]);
		await run(h, 'set_host_fields', { name: 'pub_a', qualities: null });
		expect(h.registry().hosts[0]?.qualities).toBeNull();
	});

	test('public_url: an http(s) origin only — http accepted (an http-only intranet, §7)', () => {
		expect(normalizePublicUrl('https://www.museum.test')).toBe('https://www.museum.test');
		expect(normalizePublicUrl('https://www.museum.test/')).toBe('https://www.museum.test');
		expect(normalizePublicUrl('http://www.museum.test')).toBe('http://www.museum.test');
		expect(normalizePublicUrl('http://intranet.museum.test:8080')).toBe(
			'http://intranet.museum.test:8080',
		);
		expect(normalizePublicUrl(null)).toBeNull();
		for (const bad of [
			'ftp://www.museum.test',
			'www.museum.test',
			'http://www.museum.test/site',
			'http://u:pw@www.museum.test',
			'https://www.museum.test/site',
			'https://user:pw@www.museum.test',
			'https://www.museum.test/?q=1',
			'https://www.museum.test/#x',
			'not a url',
			42,
		]) {
			expect(() => normalizePublicUrl(bad), String(bad)).toThrow(DedaloError);
		}
	});

	test('refusals write nothing', async () => {
		const refusals: Record<string, unknown>[] = [
			{ name: 'pub_a' },
			{ name: 'pub_a', qualities: [] },
			{ name: 'pub_a', qualities: ['image/original'] },
			{ name: 'pub_a', qualities: ['image/thumb', '/image/thumb'] },
			{ name: 'pub_a', qualities: [1] },
			{ name: 'pub_a', probe: { published: '../private/.env' } },
			{ name: 'pub_a', probe: { published: '/etc/passwd' } },
			{ name: 'pub_a', probe: 'image/thumb/x.jpg' },
			// the registry's grammar, not a looser copy: these would have reached saveRegistry
			{ name: 'pub_a', probe: { published: '.hidden/x.jpg' } },
			{ name: 'pub_a', probe: { published: 'image//x.jpg' } },
			{ name: 'pub_a', probe: { published: `image/${'x'.repeat(600)}` } },
			{ name: 'pub_a', qualities: ['image/.thumb'] },
			{ name: 'pub_z', public_url: null },
		];
		for (const options of refusals) {
			const h = harness([record('pub_a')]);
			const code = await codeOf(run(h, 'set_host_fields', options));
			expect(code, JSON.stringify(options)).toBe('maintenance.action_refused');
			expect(h.registry().hosts, JSON.stringify(options)).toEqual([record('pub_a')]);
		}
	});

	test('the master-tier refusal names the refused quality', async () => {
		const h = harness([record('pub_a')]);
		try {
			await run(h, 'set_host_fields', {
				name: 'pub_a',
				qualities: ['image/thumb', 'image/original'],
			});
		} catch (error) {
			expect((error as DedaloError).publicMessage).toBe(
				'Error. Not a public quality: image/original.',
			);
			return;
		}
		throw new DedaloError('internal.unexpected', { message: 'expected a refusal' });
	});
});

describe('remove_host', () => {
	test('inside ONE lock hold: secrets, then the registry entry; then the pairing proof', async () => {
		const h = harness([record('pub_a'), record('pub_b')]);
		const response = await run(h, 'remove_host', { name: 'pub_a' });
		expect(h.calls).toEqual([
			'loadRegistry',
			'updateRegistry',
			'removeHostSecrets:pub_a',
			'forgetPairing:pub_a',
		]);
		expect(h.registry().hosts.map((host) => host.name)).toEqual(['pub_b']);
		expect(response.data).toEqual({ host: 'pub_a', removed: true });
	});

	test('a secret-removal failure keeps the host registered (visible, removable again)', async () => {
		const h = harness([record('pub_a')], {
			removeHostSecrets: () => {
				throw new Error('EACCES');
			},
		});
		expect(await codeOf(run(h, 'remove_host', { name: 'pub_a' }))).toBe(
			'maintenance.action_failed',
		);
		expect(h.calls).not.toContain('forgetPairing:pub_a');
		expect(h.registry().hosts).toEqual([record('pub_a')]);
	});

	test('a pair `replace` between the read and the lock: refused, the NEW pairing untouched', async () => {
		const repaired = record('pub_a', {
			fingerprint: 'b'.repeat(64),
			paired_at: '2026-10-04T00:00:00.000Z',
		});
		let loaded = 0;
		let file: RegistryFile = { version: 1, hosts: [record('pub_a')] };
		const h = harness([], {
			loadRegistry: () => {
				loaded += 1;
				return structuredClone(file);
			},
			updateRegistry: (fn) => {
				file = { version: 1, hosts: [repaired] }; // the CLI won the race
				file = fn(structuredClone(file));
				return file;
			},
		});
		expect(await codeOf(run(h, 'remove_host', { name: 'pub_a' }))).toBe(
			'maintenance.action_refused',
		);
		expect(loaded).toBe(1);
		expect(file.hosts).toEqual([repaired]);
		expect(h.calls).not.toContain('removeHostSecrets:pub_a');
		expect(h.calls).not.toContain('forgetPairing:pub_a');
	});
});

describe('set_host_fields against the REAL registry (one grammar)', () => {
	let scratch: ReturnType<typeof useScratchPublicationHostsBase>;
	beforeEach(() => {
		scratch = useScratchPublicationHostsBase();
	});
	afterEach(() => {
		scratch.dispose();
	});

	function realHarness(): Harness {
		saveRegistry({ version: 1, hosts: [record('pub_a')] });
		return harness([], { loadRegistry, updateRegistry });
	}

	test('real public qualities (image/1.5MB) and a probe path are stored', async () => {
		const h = realHarness();
		await run(h, 'set_host_fields', {
			name: 'pub_a',
			qualities: ['image/1.5MB', 'av/404'],
			probe: { published: 'image/1.5MB/0/rsc29_rsc170_1.jpg', unpublished: null },
		});
		const stored = loadRegistry().hosts[0];
		expect(stored?.qualities).toEqual(['image/1.5MB', 'av/404']);
		expect(stored?.probe.published).toBe('image/1.5MB/0/rsc29_rsc170_1.jpg');
	});

	test('a value the registry refuses is the operator input error, never registry_invalid', async () => {
		for (const options of [
			{ name: 'pub_a', qualities: ['image/.thumb'] },
			{ name: 'pub_a', probe: { published: '.hidden/x.jpg', unpublished: null } },
		]) {
			const h = realHarness();
			const code = await codeOf(run(h, 'set_host_fields', options));
			expect(code, JSON.stringify(options)).toBe('maintenance.action_refused');
			expect(loadRegistry().hosts).toEqual([record('pub_a')]);
		}
	});
});

// ─────────────────────── New publication host: one machine first (§1.1), First use (step 10)

describe('New publication host on the panel: one machine first, then First use', () => {
	const SOURCE: InstallSource = {
		root: '/home/ded_1/dedalo',
		bun: '/opt/dedalo/bun/1.4.4/bun',
		user: 'ded_1',
		agentDeps: true,
	};
	const oneMachine = (instance: string): PanelDraft => ({
		instance,
		layout: 'home',
		apis: 'v2_only',
		listen: { kind: 'unix' },
		agent_user: `${instance}_agent`,
		engine_group: 'ded_1',
		web: { server: 'apache' },
		site: { domain: `${instance}.test` },
		media: { mode: 'shared', root: '/home/ded_1/media' },
		v2: { unit: `dedalo-publication-api-v2-${instance}`, user: `${instance}_v2`, port: 3100 },
	});
	const stored = (name: string, draft: PanelDraft): StoredDraft => ({
		name,
		created_at: '2026-11-25T00:00:00.000Z',
		created_by: -1,
		draft,
	});
	const DRAFTS: StoredDraft[] = [
		stored('museum_org', oneMachine('museum_org')),
		stored('museum_www', oneMachine('museum_www')),
		stored('archive_org', {
			...oneMachine('archive_org'),
			listen: { kind: 'tls', host: '10.20.0.9', port: 8471 },
			engine_group: undefined,
			media: { mode: 'copy', root: '/srv/pub/archive_org' },
		}),
	];

	async function setupWith(sourceCalls: { n: number }): Promise<SetupDeps> {
		const real = await loadDefaultSetupDeps();
		return {
			...real,
			loadDrafts: () => ({ version: 1, drafts: structuredClone(DRAFTS) }),
			cachedKit: async () => null,
			installSource: async () => {
				sourceCalls.n += 1;
				return { ...SOURCE };
			},
		};
	}

	test("root's awaiting ONE-MACHINE draft carries the install block; a paired or two-machine draft none; a non-root admin sees no draft at all", async () => {
		// museum_www is paired (init paired it itself, over the socket): the registry holds it
		const h = harness([
			record('pub_a'),
			record('museum_www', {
				instance: 'museum_www',
				address: { kind: 'unix', socket: '/run/dedalo_publication_host/museum_www.sock' },
			}),
		]);
		const sourceCalls = { n: 0 };
		const setup = await setupWith(sourceCalls);
		const module = createPublicationHostsWidget(
			async () => h.deps,
			async () => setup,
		);
		const data = (await module.getValue?.({}, ROOT))?.data as Record<string, unknown>;
		expect(data.drafts_state).toBe('ok');
		const drafts = data.drafts as Record<string, unknown>[];
		const byName = Object.fromEntries(drafts.map((row) => [row.name, row]));
		expect(byName.museum_org).toMatchObject({ state: 'awaiting', paired_as: null });
		expect(byName.museum_www).toMatchObject({ state: 'paired', paired_as: 'museum_www' });
		expect(byName.archive_org).toMatchObject({ state: 'awaiting' });
		const install = byName.museum_org?.install as Record<string, unknown>;
		expect(install).toMatchObject({
			source: SOURCE.root,
			draft_file: '/root/museum_org.draft.json',
			agent_deps: true,
		});
		expect(install.command).toContain(
			'sh /home/ded_1/dedalo/publication/host_agent/deploy/install.sh museum_org --source /home/ded_1/dedalo --draft /root/museum_org.draft.json\n',
		);
		expect(byName.museum_www?.install).toBeNull(); // paired: nothing to install
		expect(byName.archive_org?.install).toBeNull(); // two machines: the kit + the package
		expect(sourceCalls.n).toBe(1); // read once per panel load, not per draft

		// a non-root admin: no drafts key, and nothing of the block in the payload
		const admin = (await module.getValue?.({}, ADMIN))?.data as Record<string, unknown>;
		expect('drafts' in admin).toBe(false);
		expect('drafts_state' in admin).toBe(false);
		const serialized = JSON.stringify(admin);
		expect(serialized).not.toContain('install.sh');
		expect(serialized).not.toContain(SOURCE.root);
		expect(sourceCalls.n).toBe(1);
	});

	test("FIRST USE is the widget's own actions in docs step 10 order — apply_rules, push_apis for that ONE host, probe_public — each root-only", async () => {
		const pushed: unknown[] = [];
		const h = harness([record('pub_a')], {
			reconcilePublicationApis: async (options) => {
				pushed.push(options);
				h.calls.push('reconcilePublicationApis');
				return {
					release: '7.0.1_abcdef0',
					refused: null,
					hosts: [
						{
							name: 'pub_a',
							v1: { action: 'install', result: 'ok' },
							v2: { action: 'install', result: 'ok' },
						},
					],
				};
			},
		});
		// the chain the client runs (render_new_host.js FIRST_USE_STEPS), step by step
		const rules = await run(h, 'apply_rules', { name: 'pub_a' });
		const push = await run(h, 'push_apis', { hosts: ['pub_a'] });
		const probe = await run(h, 'probe_public', { name: 'pub_a' });
		expect(rules.msg).toStartWith('OK. Media rules applied');
		expect(push.data).toBe(true); // the client reads `true` as the step's ok
		expect(push.extend).toMatchObject({ running: false });
		expect(pushed).toEqual([expect.objectContaining({ apply: true, hosts: ['pub_a'] })]);
		expect((probe.data as { state: string }).state).toBe('ok');
		const order = h.calls.filter((call) =>
			/^(hostApplyRules|reconcilePublicationApis|probePublicGate)/.test(call),
		);
		expect(order.map((call) => call.split(':')[0])).toEqual([
			'hostApplyRules',
			'reconcilePublicationApis',
			'probePublicGate',
		]);
		// root-only, each one (a non-root admin is refused before anything loads)
		for (const action of ['apply_rules', 'push_apis', 'probe_public'] as const) {
			const fresh = harness([record('pub_a')]);
			expect(await codeOf(run(fresh, action, { name: 'pub_a', hosts: ['pub_a'] }, ADMIN))).toBe(
				'perm.denied',
			);
			expect(fresh.loads()).toBe(0);
		}
	});

	test('the pairing answer names First use as the next step', () => {
		expect(FIRST_USE_NEXT).toContain('First use');
		expect(FIRST_USE_NEXT).toContain('media rules, API releases, public check');
	});
});
