/**
 * The publication-host panel status (src/core/publication_host/host_status.ts): PURE, so
 * every input is built here, no agent, no registry file, no config. Pins the check
 * vocabulary per state, the "unproved agent says nothing" law (phase-3 Review Focus 1),
 * the registry-invalid line (Review Focus 2), that no secret or agent prose reaches a row
 * (Review Focus 5), that every `publication_host.*` code is classified, and that the
 * lockstep compares against DEDALO_VERSION (untagged), never the tagged engine version.
 */

import { describe, expect, test } from 'bun:test';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { ERROR_CODES } from '../../src/core/errors/registry.ts';
import type { AgentStatus, MediaProbe } from '../../src/core/publication_host/agent_client.ts';
import {
	buildHostChecks,
	buildHostPanelRow,
	DECORATOR_CHECK_IDS,
	HOST_CHECK_IDS,
	type HostCheck,
	type HostStatusInput,
	nginxMapCheck,
	PAIRING_ON_FAILURE,
	REACHABLE_ON_FAILURE,
	registryInvalidCheck,
	statusOutcomeFromError,
	withNginxMapCheck,
} from '../../src/core/publication_host/host_status.ts';
import { publicationHostFingerprint } from '../../src/core/publication_host/pairing.ts';
import type { PublicationHostRecord } from '../../src/core/publication_host/registry.ts';
import { registryError } from '../../src/core/publication_host/wire.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../../src/core/update/version.ts';

const TOKEN = 'publication-host-status-token-000000000000';
/** Stands in for key material (never a PEM-shaped literal: the secret scanner would flag it). */
const KEY_SENTINEL = 'engine-bundle-key-material-sentinel';
const FINGERPRINT = publicationHostFingerprint('test', TOKEN);
const OTHER_FINGERPRINT = publicationHostFingerprint('test', `${TOKEN}-rotated`);
const ENGINE = '9.1.0';
/** The work system's Bun pin in these fixtures; the healthy agent runs exactly it. */
const BUN_PIN = '1.4.2';
const RELEASE = `${ENGINE}_a1b2c3d`;
const HASH = 'a'.repeat(64);

const RECORD: PublicationHostRecord = {
	name: 'pubtest',
	instance: 'test',
	fingerprint: FINGERPRINT,
	address: { kind: 'tls', host: 'agent.pub.test', port: 8443 },
	public_url: 'https://www.pub.test',
	qualities: null,
	probe: { published: null, unpublished: null },
	paired_at: '2026-10-03T10:00:00.000Z',
};

const UNIX_RECORD: PublicationHostRecord = {
	...RECORD,
	name: 'pubtest_local',
	address: { kind: 'unix', socket: '/run/dedalo-pubhost/test.sock' },
};

interface StatusPatch {
	media?: Partial<MediaProbe>;
	rules?: Partial<AgentStatus['rules']>;
	apis?: Partial<AgentStatus['apis']>;
	instance_fingerprint?: string;
	served_apis?: AgentStatus['served_apis'];
}

function agentStatus(patch: StatusPatch = {}): AgentStatus {
	return {
		agent_version: '0.1.0',
		bun_version: BUN_PIN,
		platform: 'linux-x64',
		instance_fingerprint: patch.instance_fingerprint ?? FINGERPRINT,
		apis: {
			v1: { current: RELEASE, previous: null },
			v2: { current: RELEASE, previous: null },
			...patch.apis,
		},
		served_apis: patch.served_apis ?? ['v1', 'v2'],
		rules: { server: 'apache', hash: HASH, ...patch.rules },
		media: {
			mode: 'shared',
			root: '/srv/dedalo_media_ro',
			present: true,
			read_only: true,
			pub_readable: true,
			pub_markers: 3,
			problems: [],
			...patch.media,
		},
		disk: { state_root_free_bytes: 1_000_000 },
	};
}

function healthy(patch: Partial<HostStatusInput> = {}): HostStatusInput {
	return {
		record: RECORD,
		secrets: { token_present: true, bundle_present: true, refused: null },
		status: { ok: true, status: agentStatus() },
		expected: { ok: true, hash: HASH, dropped: [] },
		engineVersion: ENGINE,
		bunPin: BUN_PIN,
		...patch,
	};
}

function withStatus(patch: StatusPatch, expectedHash = HASH): HostStatusInput {
	return healthy({
		status: { ok: true, status: agentStatus(patch) },
		expected: { ok: true, hash: expectedHash, dropped: [] },
	});
}

function byId(checks: HostCheck[]): Record<string, Omit<HostCheck, 'id'>> {
	return Object.fromEntries(checks.map(({ id, ...rest }) => [id, rest]));
}

function checkOf(input: HostStatusInput, id: HostCheck['id']): Omit<HostCheck, 'id'> | undefined {
	return byId(buildHostChecks(input))[id];
}

const AGENT_DERIVED = [
	'agent_version',
	'bun_version',
	'media_mode',
	'media_mount',
	'media_read_only',
	'rules_hash',
	'api_v1',
	'api_v2',
] as const;

describe('buildHostChecks: a healthy shared host', () => {
	test('every check is present, in HOST_CHECK_IDS order, and ok', () => {
		const checks = buildHostChecks(healthy());
		expect(checks.map((entry) => entry.id)).toEqual([...HOST_CHECK_IDS]);
		expect(checks.filter((entry) => entry.state !== 'ok')).toEqual([]);
	});

	test('details are facts: paired_at, agent version, mode, marker count, hash prefix, release', () => {
		expect(byId(buildHostChecks(healthy()))).toEqual({
			registry: { state: 'ok', detail: RECORD.paired_at },
			secrets: { state: 'ok' },
			reachable: { state: 'ok' },
			pairing: { state: 'ok' },
			agent_version: { state: 'ok', detail: '0.1.0' },
			bun_version: { state: 'ok', detail: BUN_PIN },
			media_mode: { state: 'ok', detail: 'shared' },
			media_mount: { state: 'ok', detail: '3' },
			media_read_only: { state: 'ok', detail: 'read_only' },
			rules_hash: { state: 'ok', detail: HASH.slice(0, 12) },
			api_v1: { state: 'ok', detail: RELEASE },
			api_v2: { state: 'ok', detail: RELEASE },
		});
	});
});

describe('pairing and transport (Review Focus 1)', () => {
	test('pairing_mismatch: the agent answered, the proof failed, and nothing it says is read', () => {
		const input = healthy({
			status: { ok: false, code: 'publication_host.pairing_mismatch' },
			expected: null,
		});
		const checks = byId(buildHostChecks(input));
		expect(checks.reachable).toEqual({ state: 'ok', detail: 'publication_host.pairing_mismatch' });
		expect(checks.pairing).toEqual({
			state: 'blocked',
			detail: 'publication_host.pairing_mismatch',
		});
		for (const id of AGENT_DERIVED) {
			expect(checks[id]).toEqual({ state: 'unknown', detail: 'status_unavailable' });
		}
		const row = buildHostPanelRow(input);
		expect(row.pairing_proved).toBe(false);
		expect(row.rules).toEqual({ expected: null, reported: null });
		expect(row.bun).toEqual({ expected: BUN_PIN, reported: null });
	});

	// A failure minted BEFORE any dial (the local token-vs-registry check, the registry lock)
	// says nothing about the agent: never reachable ok, never pairing ok.
	test('a LOCAL pairing_mismatch (nothing dialled) is reachable unknown, pairing blocked', () => {
		const input = healthy({
			status: { ok: false, code: 'publication_host.pairing_mismatch', local: true },
			expected: null,
		});
		const checks = byId(buildHostChecks(input));
		expect(checks.reachable).toEqual({
			state: 'unknown',
			detail: 'publication_host.pairing_mismatch',
		});
		expect(checks.pairing).toEqual({
			state: 'blocked',
			detail: 'publication_host.pairing_mismatch',
		});
		expect(buildHostPanelRow(input).pairing_proved).toBe(false);
	});

	test('a LOCAL busy (the registry lock, nothing dialled) is reachable unknown, pairing unknown', () => {
		const input = healthy({
			status: { ok: false, code: 'publication_host.busy', local: true },
			expected: null,
		});
		const checks = byId(buildHostChecks(input));
		expect(checks.reachable).toEqual({ state: 'unknown', detail: 'publication_host.busy' });
		expect(checks.pairing).toEqual({ state: 'unknown', detail: 'publication_host.busy' });
		expect(buildHostPanelRow(input).pairing_proved).toBe(false);
	});

	test('statusOutcomeFromError marks an error minted before any dial as local', () => {
		expect(statusOutcomeFromError(registryError('locked'))).toEqual({
			ok: false,
			code: 'publication_host.busy',
			local: true,
		});
	});

	test('a status body whose fingerprint is not the registry one is NOT trusted', () => {
		const input = withStatus({ instance_fingerprint: OTHER_FINGERPRINT });
		const checks = byId(buildHostChecks(input));
		expect(checks.pairing).toEqual({ state: 'blocked', detail: 'status_fingerprint' });
		for (const id of AGENT_DERIVED) {
			expect(checks[id]).toEqual({ state: 'unknown', detail: 'status_unavailable' });
		}
		const row = buildHostPanelRow(input);
		expect(row.pairing_proved).toBe(false);
		expect(row.rules).toEqual({ expected: null, reported: null });
		expect(row.apis).toEqual({
			v1: { current: null, previous: null },
			v2: { current: null, previous: null },
		});
	});

	test('a non-hex fingerprint in the body is a mismatch, never a pass', () => {
		expect(checkOf(withStatus({ instance_fingerprint: 'not-a-fingerprint' }), 'pairing')).toEqual({
			state: 'blocked',
			detail: 'status_fingerprint',
		});
	});

	test.each([
		['publication_host.unreachable', 'blocked', 'unknown'],
		['publication_host.timeout', 'blocked', 'unknown'],
		['publication_host.unconfigured', 'unknown', 'unknown'],
		['publication_host.registry_invalid', 'unknown', 'unknown'],
		['publication_host.auth', 'ok', 'blocked'],
		['publication_host.failed', 'ok', 'ok'],
		['publication_host.busy', 'ok', 'ok'],
		['publication_host.rejected', 'ok', 'ok'],
		['internal.unexpected', 'unknown', 'unknown'],
	] as const)('%s → reachable %s, pairing %s', (code, reachable, pairing) => {
		const checks = byId(buildHostChecks(healthy({ status: { ok: false, code }, expected: null })));
		expect(checks.reachable).toEqual({ state: reachable, detail: code });
		expect(checks.pairing).toEqual({ state: pairing, detail: code });
	});

	test('every publication_host.* code in the error registry is classified on BOTH checks', () => {
		const family = ERROR_CODES.filter((code) => code.startsWith('publication_host.')).sort();
		expect(family.length).toBeGreaterThanOrEqual(9);
		expect([...REACHABLE_ON_FAILURE.keys()].sort()).toEqual(family);
		expect([...PAIRING_ON_FAILURE.keys()].sort()).toEqual(family);
	});
});

describe('secrets', () => {
	test('a TLS host needs the token AND the engine bundle', () => {
		expect(
			checkOf(
				healthy({ secrets: { token_present: false, bundle_present: false, refused: null } }),
				'secrets',
			),
		).toEqual({ state: 'blocked', detail: 'token,engine_bundle' });
		expect(
			checkOf(
				healthy({ secrets: { token_present: true, bundle_present: false, refused: null } }),
				'secrets',
			),
		).toEqual({ state: 'blocked', detail: 'engine_bundle' });
	});

	test('a unix-socket host needs only the token (no mTLS on a local socket)', () => {
		const secrets = { token_present: true, bundle_present: false, refused: null };
		expect(checkOf(healthy({ record: UNIX_RECORD, secrets }), 'secrets')).toEqual({ state: 'ok' });
		expect(
			checkOf(
				healthy({
					record: UNIX_RECORD,
					secrets: { token_present: false, bundle_present: false, refused: null },
				}),
				'secrets',
			),
		).toEqual({ state: 'blocked', detail: 'token' });
	});

	test('a present but REFUSED secret is blocked with the refusal reason, never read as absence', () => {
		const refused = { token_present: false, bundle_present: true, refused: 'bad_mode' as const };
		expect(checkOf(healthy({ secrets: refused }), 'secrets')).toEqual({
			state: 'blocked',
			detail: 'bad_mode',
		});
		expect(checkOf(healthy({ record: UNIX_RECORD, secrets: refused }), 'secrets')).toEqual({
			state: 'blocked',
			detail: 'bad_mode',
		});
	});

	test('a refusal blocks even when both presence flags read true', () => {
		const secrets = { token_present: true, bundle_present: true, refused: 'bad_owner' as const };
		expect(checkOf(healthy({ secrets }), 'secrets')).toEqual({
			state: 'blocked',
			detail: 'bad_owner',
		});
	});
});

describe('media', () => {
	test('a writable shared mount is blocked: the public host could rewrite the work media', () => {
		expect(checkOf(withStatus({ media: { read_only: false } }), 'media_read_only')).toEqual({
			state: 'blocked',
			detail: 'writable',
		});
	});

	test('a copy root must be writable, and a read-only one is blocked', () => {
		const copy = { mode: 'copy' as const, pub_readable: null, pub_markers: null };
		expect(
			checkOf(withStatus({ media: { ...copy, read_only: false } }), 'media_read_only'),
		).toEqual({
			state: 'ok',
			detail: 'writable',
		});
		expect(checkOf(withStatus({ media: { ...copy, read_only: true } }), 'media_read_only')).toEqual(
			{
				state: 'blocked',
				detail: 'read_only',
			},
		);
	});

	test('copy mode is a served mode (phase 5): ok, and its gate is checked like a shared one', () => {
		const input = withStatus({ media: { mode: 'copy', read_only: false, pub_readable: null } });
		expect(checkOf(input, 'media_mode')).toEqual({ state: 'ok', detail: 'copy' });
		expect(checkOf(input, 'media_mount')).toEqual({ state: 'ok', detail: 'present' });
		// the copy root's gate is the publication_host profile (rules.ts rulesRootFor):
		// never not_applicable — a copy host without it serves an unpublished file
		expect(checkOf(input, 'rules_hash')).not.toEqual({ state: 'ok', detail: 'not_applicable' });
		expect(checkOf({ ...input, expected: { ok: false, reason: 'root' } }, 'rules_hash')).toEqual({
			state: 'blocked',
			detail: 'root',
		});
	});

	test('an unmeasured read-only state is unknown, never assumed', () => {
		expect(checkOf(withStatus({ media: { read_only: null } }), 'media_read_only')).toEqual({
			state: 'unknown',
			detail: 'unmeasured',
		});
	});

	test('an absent root and an unreadable marker store are blocked', () => {
		expect(
			checkOf(withStatus({ media: { present: false, read_only: null } }), 'media_mount'),
		).toEqual({ state: 'blocked', detail: 'absent' });
		expect(checkOf(withStatus({ media: { pub_readable: false } }), 'media_mount')).toEqual({
			state: 'blocked',
			detail: 'pub_unreadable',
		});
	});

	test('mode none: a warning, and nothing to mount, measure or gate', () => {
		const checks = byId(
			buildHostChecks(
				withStatus({
					media: { mode: 'none', root: null, present: false, read_only: null, pub_readable: null },
				}),
			),
		);
		expect(checks.media_mode).toEqual({ state: 'warn', detail: 'none' });
		expect(checks.media_mount).toEqual({ state: 'ok', detail: 'none' });
		expect(checks.media_read_only).toEqual({ state: 'ok', detail: 'none' });
		expect(checks.rules_hash).toEqual({ state: 'ok', detail: 'not_applicable' });
	});
});

describe('rules_hash', () => {
	test('no include applied is blocked', () => {
		expect(checkOf(withStatus({ rules: { hash: null } }), 'rules_hash')).toEqual({
			state: 'blocked',
			detail: 'none',
		});
	});

	test('a reported hash that is not the expected one is blocked as drift', () => {
		expect(checkOf(withStatus({}, 'b'.repeat(64)), 'rules_hash')).toEqual({
			state: 'blocked',
			detail: 'drift',
		});
	});

	test('a match whose override dropped a quality warns and names it', () => {
		const input = healthy({ expected: { ok: true, hash: HASH, dropped: ['image/original'] } });
		expect(checkOf(input, 'rules_hash')).toEqual({
			state: 'warn',
			detail: 'dropped:image/original',
		});
	});

	test.each(['mode', 'server', 'root', 'input'] as const)(
		'an expected-rules refusal (%s) is blocked with its reason',
		(reason) => {
			expect(checkOf(healthy({ expected: { ok: false, reason } }), 'rules_hash')).toEqual({
				state: 'blocked',
				detail: reason,
			});
		},
	);

	test('a shared host with no expected outcome computed is blocked, not ok', () => {
		expect(checkOf(healthy({ expected: null }), 'rules_hash')).toEqual({
			state: 'blocked',
			detail: 'not_computed',
		});
	});
});

describe('API lockstep (spec §3)', () => {
	test('a v2-only site (served_apis [v2]): api_v1 is ok not_served — neutral, never warn — and v2 is still checked', () => {
		const input = withStatus({
			served_apis: ['v2'],
			apis: { v1: { current: null, previous: null } },
		});
		expect(checkOf(input, 'api_v1')).toEqual({ state: 'ok', detail: 'not_served' });
		expect(checkOf(input, 'api_v2')).toEqual({ state: 'ok', detail: RELEASE });
		expect(buildHostPanelRow(input).served_apis).toEqual(['v2']);
	});

	test('served_apis is null on a row whose status was not proved', () => {
		expect(
			buildHostPanelRow(healthy({ status: { ok: false, code: 'publication_host.unreachable' } }))
				.served_apis,
		).toBeNull();
	});

	test('no release installed warns', () => {
		expect(
			checkOf(withStatus({ apis: { v1: { current: null, previous: null } } }), 'api_v1'),
		).toEqual({ state: 'warn', detail: 'none' });
	});

	test('a release of another engine version warns with both versions', () => {
		expect(
			checkOf(
				withStatus({ apis: { v2: { current: '9.0.9_a1b2c3d', previous: RELEASE } } }),
				'api_v2',
			),
		).toEqual({ state: 'warn', detail: `9.0.9_a1b2c3d != ${ENGINE}` });
	});

	test('engineVersion is DEDALO_VERSION (no tag): a prerelease-tagged version would warn for ever', () => {
		expect(formatVersion(DEDALO_DATA_VERSION)).toMatch(/^\d+\.\d+\.\d+$/);
		const release = `${formatVersion(DEDALO_DATA_VERSION)}_a1b2c3d`;
		const apis = {
			v1: { current: release, previous: null },
			v2: { current: release, previous: null },
		};
		const base = healthy({ status: { ok: true, status: agentStatus({ apis }) } });
		expect(
			checkOf({ ...base, engineVersion: formatVersion(DEDALO_DATA_VERSION) }, 'api_v1'),
		).toEqual({
			state: 'ok',
			detail: release,
		});
		// What passing DEDALO_ENGINE_VERSION (`${DEDALO_VERSION}.dev`) on a dev build would do:
		expect(
			checkOf({ ...base, engineVersion: `${formatVersion(DEDALO_DATA_VERSION)}.dev` }, 'api_v1'),
		).toEqual({
			state: 'warn',
			detail: `${release} != ${formatVersion(DEDALO_DATA_VERSION)}.dev`,
		});
	});
});

describe('registry and outcomes', () => {
	test('an invalid registry is one loud blocked line naming the reason (Review Focus 2)', () => {
		expect(registryInvalidCheck('invalid_json')).toEqual({
			id: 'registry',
			state: 'blocked',
			detail: 'invalid_json',
		});
	});

	test('statusOutcomeFromError keeps the typed code and drops every message', () => {
		const typed = new DedaloError('publication_host.failed', { message: `agent said: ${TOKEN}` });
		expect(statusOutcomeFromError(typed)).toEqual({ ok: false, code: 'publication_host.failed' });
		const untyped = statusOutcomeFromError(new Error(`boom ${KEY_SENTINEL}`));
		expect(untyped).toEqual({ ok: false, code: 'internal.unexpected' });
		expect(JSON.stringify(untyped)).not.toContain(KEY_SENTINEL);
	});
});

describe('buildHostPanelRow', () => {
	test('the row of a healthy host', () => {
		expect(buildHostPanelRow(healthy())).toEqual({
			name: 'pubtest',
			address_label: 'agent.pub.test:8443',
			public_url: 'https://www.pub.test',
			checks: buildHostChecks(healthy()),
			rules: { expected: HASH, reported: HASH },
			bun: { expected: BUN_PIN, reported: BUN_PIN },
			apis: { v1: { current: RELEASE, previous: null }, v2: { current: RELEASE, previous: null } },
			served_apis: ['v1', 'v2'],
			token_present: true,
			bundle_present: true,
			pairing_proved: true,
		});
	});

	test('a unix host is labelled by its socket', () => {
		expect(buildHostPanelRow(healthy({ record: UNIX_RECORD })).address_label).toBe(
			'unix:/run/dedalo-pubhost/test.sock',
		);
	});

	test('no secret, no agent prose and no extra agent field reaches the row (Review Focus 5)', () => {
		const status = agentStatus({
			media: { problems: [`cannot write ${TOKEN}`, KEY_SENTINEL] },
		}) as AgentStatus & { apis: { v1: { leaked?: string } } };
		status.apis.v1.leaked = TOKEN;
		const row = buildHostPanelRow(healthy({ status: { ok: true, status } }));
		const serialized = JSON.stringify(row);
		expect(serialized).not.toContain(TOKEN);
		expect(serialized).not.toContain(KEY_SENTINEL);
		expect(serialized).not.toContain(FINGERPRINT);
		expect(Object.keys(row.apis.v1).sort()).toEqual(['current', 'previous']);
	});

	test('agent free strings cross only in their shape: malformed in the check, null in the row', () => {
		const hostile = `<img src=x onerror=alert(1)>${'A'.repeat(100_000)}`;
		const status = agentStatus({
			apis: { v1: { current: hostile, previous: hostile } },
			rules: { hash: hostile },
		});
		status.agent_version = hostile;
		status.bun_version = hostile;
		const input = healthy({ status: { ok: true, status } });
		const row = buildHostPanelRow(input);
		const checks = byId(row.checks);
		expect(checks.agent_version).toEqual({ state: 'warn', detail: 'malformed' });
		expect(checks.bun_version).toEqual({ state: 'blocked', detail: 'malformed' });
		expect(row.bun.reported).toBeNull();
		expect(checks.api_v1).toEqual({ state: 'warn', detail: 'malformed' });
		expect(checks.rules_hash).toEqual({ state: 'blocked', detail: 'malformed' });
		expect(row.apis.v1).toEqual({ current: null, previous: null });
		expect(row.rules.reported).toBeNull();
		expect(JSON.stringify(row)).not.toContain('onerror');
	});

	test('a well-shaped prerelease agent version is still a fact', () => {
		const status = agentStatus();
		status.agent_version = '0.2.0-rc.1';
		expect(checkOf(healthy({ status: { ok: true, status } }), 'agent_version')).toEqual({
			state: 'ok',
			detail: '0.2.0-rc.1',
		});
	});
});

/** A status body whose agent runs `bunVersion`, trusted (registry fingerprint). */
function runningBun(bunVersion: string, patch: Partial<HostStatusInput> = {}): HostStatusInput {
	const status = agentStatus();
	status.bun_version = bunVersion;
	return healthy({ status: { ok: true, status }, ...patch });
}

describe('bun_version: the host Bun against the work system pin', () => {
	test('equal: ok, the version is the fact, both sides in the row', () => {
		const input = runningBun(BUN_PIN);
		expect(checkOf(input, 'bun_version')).toEqual({ state: 'ok', detail: BUN_PIN });
		expect(buildHostPanelRow(input).bun).toEqual({ expected: BUN_PIN, reported: BUN_PIN });
	});

	test('differ (patch, minor, prerelease tail): blocked (red), both versions named', () => {
		for (const reported of ['1.4.1', '1.4.3', '1.5.2', '1.4.2-canary.20+abc1234']) {
			const input = runningBun(reported);
			expect(checkOf(input, 'bun_version')).toEqual({
				state: 'blocked',
				detail: `${reported} != ${BUN_PIN}`,
			});
			expect(buildHostPanelRow(input).bun).toEqual({ expected: BUN_PIN, reported });
		}
	});

	test('unreachable: unknown, nothing reported in the row', () => {
		const input = healthy({
			status: { ok: false, code: 'publication_host.unreachable' },
			expected: null,
		});
		expect(checkOf(input, 'bun_version')).toEqual({
			state: 'unknown',
			detail: 'status_unavailable',
		});
		expect(buildHostPanelRow(input).bun).toEqual({ expected: BUN_PIN, reported: null });
	});

	test('not reported (empty string): unknown, never ok', () => {
		expect(checkOf(runningBun(''), 'bun_version')).toEqual({
			state: 'unknown',
			detail: 'not_reported',
		});
	});

	test('this work system pins no Bun: unknown (nothing to compare), the host fact still shown', () => {
		const input = runningBun('1.4.2', { bunPin: null });
		expect(checkOf(input, 'bun_version')).toEqual({ state: 'unknown', detail: 'unpinned' });
		expect(buildHostPanelRow(input).bun).toEqual({ expected: null, reported: '1.4.2' });
	});

	test('the comparison is exact: a pin that is a prefix of the reported version is a drift', () => {
		expect(checkOf(runningBun('1.4.20'), 'bun_version')?.state).toBe('blocked');
		expect(checkOf(runningBun('1.4.2', { bunPin: '1.4.20' }), 'bun_version')?.state).toBe(
			'blocked',
		);
	});
});

describe('nginx_map: the host-wide map state is a check (B3)', () => {
	const H = 'e'.repeat(64);
	const managed = {
		managed: true,
		expected: H,
		applied: H,
		host_hash: H,
		contributions: 1,
		invalid: 0,
		refused: null,
		drift: false,
		agent_outdated: false,
	};

	test('every state the panel showed maps to one check, red where it was red', () => {
		expect(DECORATOR_CHECK_IDS).toContain('nginx_map');
		expect(nginxMapCheck(managed)).toEqual({
			id: 'nginx_map',
			state: 'ok',
			detail: H.slice(0, 12),
		});
		expect(nginxMapCheck({ ...managed, applied: 'f'.repeat(64), drift: true })).toEqual({
			id: 'nginx_map',
			state: 'blocked',
			detail: 'drift',
		});
		expect(nginxMapCheck({ ...managed, applied: null, drift: true })).toEqual({
			id: 'nginx_map',
			state: 'blocked',
			detail: 'none',
		});
		expect(nginxMapCheck({ ...managed, refused: 'map_envelope_rebind' })).toEqual({
			id: 'nginx_map',
			state: 'blocked',
			detail: 'map_envelope_rebind',
		});
		expect(nginxMapCheck({ ...managed, managed: false, expected: null, applied: null })).toEqual({
			id: 'nginx_map',
			state: 'ok',
			detail: 'unmanaged',
		});
		expect(
			nginxMapCheck({ ...managed, managed: false, agent_outdated: true, drift: true }),
		).toEqual({ id: 'nginx_map', state: 'blocked', detail: 'agent_outdated' });
	});

	test('withNginxMapCheck appends ONE check (a previous one replaced); a null map leaves none', () => {
		const row = { checks: [{ id: 'registry', state: 'ok' } as HostCheck] };
		const once = withNginxMapCheck(row, managed);
		expect(once.checks.map((c) => c.id)).toEqual(['registry', 'nginx_map']);
		expect(
			withNginxMapCheck(once, { ...managed, drift: true }).checks.filter(
				(c) => c.id === 'nginx_map',
			),
		).toEqual([{ id: 'nginx_map', state: 'blocked', detail: 'drift' }]);
		expect(withNginxMapCheck(once, null).checks.map((c) => c.id)).toEqual(['registry']);
	});
});
