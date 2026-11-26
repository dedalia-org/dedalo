/**
 * THE TWO-MACHINE LISTENER OVER IPv6, engine side (engineering/PUBLICATION_HOST_SPEC.md §2.2,
 * §9.14; OUTBOUND_SPEC.md §2.1). The agent's ONE listen-host grammar (publication/host_agent/
 * src/provision/layout.ts listenHostProblem — a canonical IPv4, or a private IPv6: a unique
 * local address fc00::/7 or ::1, in its RFC 5952 form) is what every engine layer reads, and
 * every comparison of two hosts goes through its canonical spelling (comparableHost):
 *
 *   1. the panel draft (drafts.ts): typed spellings canonicalized, refusals named, the same
 *      machine / paired record / next free port compared canonically, the sibling clash on one
 *      ULA found;
 *   2. the pairing (pair_flow.ts): the fragment URL's bracketed host canonical, a link-local or
 *      global IPv6 refused as address_invalid, sameAddress canonical; the panel's binding
 *      (packageBinding) accepts the draft's own address in any spelling, refuses another;
 *   3. the registry: an IPv6 host held canonical, a zone id refused;
 *   4. the paired door (transport.ts): a REAL mTLS dial of an agent on [::1], end to end through
 *      pairWith → the registry → agentRequest; a certificate naming only 127.0.0.1 is refused on
 *      identity at [::1];
 *   5. the generic outbound guard refuses the same private IPv6 — the agent's address is reachable
 *      ONLY through its own named door.
 *
 * The live dials need an IPv6 loopback; where the kernel has none they are skipped BY NAME.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { packageBinding } from '../../src/core/area_maintenance/widgets/publication_host_setup.ts';
import { addressLabel as panelAddressLabel } from '../../src/core/area_maintenance/widgets/publication_hosts.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import {
	DraftInvalid,
	type PanelDraft,
	pairedRecord,
	proposeDraft,
	readPanelDraft,
	type StoredDraft,
	sameMachine,
	validateDraft,
} from '../../src/core/publication_host/drafts.ts';
import {
	type Address,
	addressLabel,
	type FragmentFields,
	PairRefusal,
	pairWith,
	parseAgentAddress,
	sameAddress,
} from '../../src/core/publication_host/pair_flow.ts';
import { publicationHostFingerprint } from '../../src/core/publication_host/pairing.ts';
import {
	loadRegistry,
	type PublicationHostRecord,
	type RegistryFile,
	validateRegistry,
} from '../../src/core/publication_host/registry.ts';
import { AGENT_BASE_PATH, dialAgent } from '../../src/core/publication_host/transport.ts';
import { assertPublicUrl, isSsrfRefusal } from '../../src/core/security/ssrf_guard.ts';
import {
	mintTestPki,
	type TestPki,
	useScratchPublicationHostsBase,
} from '../helpers/publication_host_fixtures.ts';
import { type MockAgent, startMockAgent } from '../helpers/publication_host_mock_agent.ts';

const ULA = 'fd00:20::2';
const ULA_LONG = 'FD00:0020:0:0:0:0:0:0002';
const TOKEN = 'ipv6-listener-test-token-not-a-secret-0123456789';

/** Is [::1] bindable here? (A container with IPv6 disabled has no ::1 at all.) */
const IPV6_LOOPBACK = (() => {
	try {
		Bun.serve({ hostname: '::1', port: 0, fetch: () => new Response('') }).stop(true);
		return true;
	} catch {
		return false;
	}
})();

function tlsDraft(host: string, port = 8471, over: Partial<PanelDraft> = {}): PanelDraft {
	return {
		instance: 'museum_org',
		layout: 'home',
		apis: 'v2_only',
		listen: { kind: 'tls', host, port },
		agent_user: 'museum_org_agent',
		web: { server: 'apache' },
		site: { domain: 'museum.org' },
		media: { mode: 'copy', root: '/srv/dedalo_pub/museum_org' },
		v2: { unit: 'dedalo-publication-api-v2-museum_org', user: 'museum_org_v2', port: 3100 },
		...over,
	};
}

/** A second instance with every principal, unit, port and root of its own. */
function otherDraft(host: string, port: number): PanelDraft {
	return tlsDraft(host, port, {
		instance: 'archive_org',
		agent_user: 'archive_org_agent',
		site: { domain: 'archive.org' },
		media: { mode: 'copy', root: '/srv/dedalo_pub/archive_org' },
		v2: { unit: 'dedalo-publication-api-v2-archive_org', user: 'archive_org_v2', port: 3101 },
	});
}

function stored(name: string, draft: PanelDraft): StoredDraft {
	return { name, created_at: '2026-11-25T00:00:00.000Z', created_by: -1, draft };
}

function record(name: string, instance: string, address: Address): PublicationHostRecord {
	return {
		name,
		instance,
		fingerprint: '0'.repeat(64),
		address,
		public_url: null,
		qualities: null,
		probe: { published: null, unpublished: null },
		paired_at: '2026-11-25T00:00:00.000Z',
	};
}

const registryOf = (...hosts: PublicationHostRecord[]): RegistryFile => ({ version: 1, hosts });
const EMPTY = { drafts: [] as StoredDraft[], registry: registryOf() };

function draftIssues(fn: () => unknown): { field: string; message: string }[] {
	try {
		fn();
	} catch (error) {
		if (!(error instanceof DraftInvalid)) throw error;
		return [...error.issues];
	}
	throw new Error('expected DraftInvalid');
}

function pairRefusalOf(fn: () => unknown): PairRefusal {
	try {
		fn();
	} catch (error) {
		if (!(error instanceof PairRefusal)) throw error;
		return error;
	}
	throw new Error('expected PairRefusal');
}

const fragmentUrl = (host: string, port: number) => `https://[${host}]:${port}${AGENT_BASE_PATH}`;

// ------------------------------------------------------------------------- 1. the panel draft

describe('the panel draft over IPv6 (drafts.ts)', () => {
	test('a typed ULA in any spelling is stored in its RFC 5952 form; IPv4 unchanged', () => {
		expect(readPanelDraft(tlsDraft(ULA_LONG)).listen).toEqual({
			kind: 'tls',
			host: ULA,
			port: 8471,
		});
		expect(readPanelDraft(tlsDraft(` ${ULA} `)).listen).toEqual({
			kind: 'tls',
			host: ULA,
			port: 8471,
		});
		// pasted from a URL authority: the brackets are spelling, not address
		expect(readPanelDraft(tlsDraft(`[${ULA_LONG}]`)).listen).toEqual({
			kind: 'tls',
			host: ULA,
			port: 8471,
		});
		expect(readPanelDraft(tlsDraft('::1')).listen).toEqual({
			kind: 'tls',
			host: '::1',
			port: 8471,
		});
		expect(readPanelDraft(tlsDraft('10.20.0.2')).listen).toEqual({
			kind: 'tls',
			host: '10.20.0.2',
			port: 8471,
		});
		// and the canonical draft passes the agent's own rule set (derive() on the stand-in)
		expect(validateDraft('museum_org', readPanelDraft(tlsDraft(ULA_LONG)), EMPTY).listen).toEqual({
			kind: 'tls',
			host: ULA,
			port: 8471,
		});
	});

	test.each([
		['fe80::1', 'link-local'],
		['fe80::1%eth0', 'no zone id'],
		['2001:db8::1', 'not a private IPv6'],
		['::', 'unspecified'],
		['::ffff:10.0.0.1', 'IPv4-mapped'],
		['agent.lan', 'never a hostname'],
	])('%s is refused on listen.host, naming why (%s)', (host, why) => {
		const issues = draftIssues(() => readPanelDraft(tlsDraft(host)));
		expect(issues.map((issue) => issue.field)).toEqual(['listen.host']);
		expect(issues[0]?.message).toContain(why);
		expect(issues[0]?.message).toContain('unique local IPv6');
	});

	test('the same machine, the paired record and the next free port compare the host canonically', () => {
		const draft = tlsDraft(ULA);
		expect(sameMachine(draft.listen, { kind: 'tls', host: ULA_LONG, port: 9000 })).toBe(true);
		expect(sameMachine(draft.listen, { kind: 'tls', host: 'fd00:20::3', port: 8471 })).toBe(false);
		// a registry written by hand in a long spelling still holds THIS draft's host
		const handWritten = record('museum_org', 'museum_org', {
			kind: 'tls',
			host: ULA_LONG,
			port: 8471,
		});
		expect(pairedRecord(stored('museum_org', draft), registryOf(handWritten))?.name).toBe(
			'museum_org',
		);
		// the proposal: the typed address canonical, past the paired host's port on that address
		const proposal = proposeDraft(
			{
				domain: 'archive.org',
				machines: 'two',
				listenHost: 'FD00:20::0002',
				apis: 'v2_only',
				engineGroup: null,
				mediaRoot: null,
			},
			{ drafts: [], registry: registryOf(handWritten) },
		);
		expect(proposal.draft.listen).toEqual({ kind: 'tls', host: ULA, port: 8472 });
	});

	test('two drafts on one ULA and one port clash; another port or another ULA is fine', () => {
		const mine = readPanelDraft(tlsDraft(ULA));
		const context = (theirs: PanelDraft) => ({
			drafts: [stored('archive_org', theirs)],
			registry: registryOf(),
		});
		const clash = draftIssues(() =>
			validateDraft('museum_org', mine, context(otherDraft(ULA, 8471))),
		);
		expect(clash.map((issue) => issue.field)).toEqual(['listen.port']);
		expect(clash[0]?.message).toContain(`listen ${ULA}:8471`);
		expect(validateDraft('museum_org', mine, context(otherDraft(ULA, 8472)))).toEqual(mine);
		expect(validateDraft('museum_org', mine, context(otherDraft('fd00:20::3', 8471)))).toEqual(
			mine,
		);
		// a paired host at the same address (spelled long by hand) holds its port too
		const paired = record('archive_org', 'archive_org', {
			kind: 'tls',
			host: ULA_LONG,
			port: 8471,
		});
		const taken = draftIssues(() =>
			validateDraft('museum_org', mine, { drafts: [], registry: registryOf(paired) }),
		);
		expect(taken.map((issue) => issue.field)).toEqual(['listen.port']);
	});
});

// ----------------------------------------------------------------------------- 2. the pairing

describe('the pairing address over IPv6 (pair_flow.ts, the panel binding)', () => {
	test('the fragment URL: bracketed IPv6 parsed to its canonical host, labelled bracketed again', () => {
		const address = parseAgentAddress({ url: fragmentUrl(ULA_LONG, 8471), socket: null });
		expect(address).toEqual({ kind: 'tls', host: ULA, port: 8471 });
		expect(addressLabel(address)).toBe(`https://[${ULA}]:8471`);
		expect(parseAgentAddress({ url: fragmentUrl('::1', 8471), socket: null })).toEqual({
			kind: 'tls',
			host: '::1',
			port: 8471,
		});
	});

	test('an IPv6 the agent could never have declared is address_invalid, before anything is dialled', () => {
		for (const [host, why] of [
			['fe80::1', 'link-local'],
			['2001:db8::1', 'not a private IPv6'],
			['::ffff:10.0.0.1', 'IPv4-mapped'],
		] as const) {
			const refusal = pairRefusalOf(() =>
				parseAgentAddress({ url: fragmentUrl(host, 8471), socket: null }),
			);
			expect(refusal.reason, host).toBe('address_invalid');
			expect(refusal.message, host).toContain(why);
		}
		// a zone id is not even a URL (WHATWG refuses `%` in an IPv6 host)
		const zoned = pairRefusalOf(() =>
			parseAgentAddress({ url: `https://[fe80::1%25eth0]:8471${AGENT_BASE_PATH}`, socket: null }),
		);
		expect(zoned.reason).toBe('address_invalid');
	});

	test('sameAddress compares the host canonically', () => {
		expect(
			sameAddress(
				{ kind: 'tls', host: ULA, port: 8471 },
				{ kind: 'tls', host: ULA_LONG, port: 8471 },
			),
		).toBe(true);
		expect(
			sameAddress({ kind: 'tls', host: ULA, port: 8471 }, { kind: 'tls', host: ULA, port: 8472 }),
		).toBe(false);
		expect(
			sameAddress(
				{ kind: 'tls', host: ULA, port: 8471 },
				{ kind: 'tls', host: 'fd00:20::3', port: 8471 },
			),
		).toBe(false);
	});

	test("the panel binding: the draft's own IPv6 listener passes, another address is address_mismatch", () => {
		const bind = packageBinding(tlsDraft(ULA));
		const fields = { instance: 'museum_org' } as FragmentFields;
		expect(() => bind(fields, { kind: 'tls', host: ULA_LONG, port: 8471 })).not.toThrow();
		for (const address of [
			{ kind: 'tls', host: 'fd00:20::3', port: 8471 },
			{ kind: 'tls', host: ULA, port: 8472 },
		] as const) {
			let reason: unknown = null;
			try {
				bind(fields, address);
			} catch (error) {
				reason = error instanceof DedaloError ? error.details?.reason : error;
			}
			expect(reason).toBe('address_mismatch');
		}
	});
});

// ----------------------------------------------------------------------------- 3. the registry

describe('the registry over IPv6', () => {
	const fileWith = (host: string) => ({
		version: 1,
		hosts: [record('pub_a', 'pub_a', { kind: 'tls', host, port: 8471 })],
	});

	test('an IPv6 host is held in its RFC 5952 form', () => {
		expect(validateRegistry(fileWith(ULA_LONG)).hosts[0]?.address).toEqual({
			kind: 'tls',
			host: ULA,
			port: 8471,
		});
		expect(validateRegistry(fileWith('10.20.0.2')).hosts[0]?.address).toEqual({
			kind: 'tls',
			host: '10.20.0.2',
			port: 8471,
		});
	});

	test("the panel's address text brackets an IPv6 host so its port reads apart", () => {
		expect(panelAddressLabel({ kind: 'tls', host: ULA, port: 8471 })).toBe(`[${ULA}]:8471`);
		expect(panelAddressLabel({ kind: 'tls', host: '10.20.0.2', port: 8471 })).toBe(
			'10.20.0.2:8471',
		);
	});

	test('a zone id is refused loudly: no https URL can dial it', () => {
		expect(() => validateRegistry(fileWith('fe80::1%eth0'))).toThrow('zone id');
	});
});

// ------------------------------------------------------------- 4. the paired door, really dialled

describe('the paired door to an agent on [::1] (transport.ts)', () => {
	let pki: TestPki;
	let v4OnlyPki: TestPki;
	let agent: MockAgent | null = null;
	let scratch: { dispose: () => void } | null = null;

	beforeAll(() => {
		if (!IPV6_LOOPBACK) return;
		pki = mintTestPki('dd-pubhost-ipv6', 'IP:::1');
		v4OnlyPki = mintTestPki('dd-pubhost-ipv6-v4only', 'IP:127.0.0.1');
		agent = startMockAgent({ kind: 'tls', pki, hostname: '::1' }, 'museum_org', TOKEN);
		scratch = useScratchPublicationHostsBase();
	});

	afterAll(() => {
		agent?.stop();
		scratch?.dispose();
	});

	test.skipIf(!IPV6_LOOPBACK)(
		'pairWith proves and registers the agent at its canonical IPv6, and the registry entry is dialled over mTLS (skipped only where the kernel has no IPv6 loopback)',
		async () => {
			const port = agent?.port ?? 0;
			const fields: FragmentFields = {
				instance: 'museum_org',
				fingerprint: publicationHostFingerprint('museum_org', TOKEN),
				// the long spelling a hand-copied URL might carry: it still lands canonical
				url: fragmentUrl('0:0:0:0:0:0:0:1', port),
				socket: null,
				tlsBundle: null,
				token: TOKEN,
			};
			const outcome = await pairWith(
				{ command: 'add', name: 'museum_org', dryRun: false, tag: '[publication_host_ipv6_test]' },
				{ fields, supplied: null, bundle: () => pki.bundlePem },
			);
			expect(outcome.record.address).toEqual({ kind: 'tls', host: '::1', port });
			const registered = loadRegistry().hosts.find((host) => host.name === 'museum_org');
			expect(registered?.address).toEqual({ kind: 'tls', host: '::1', port });
			const tls = { cert: pki.clientCertPem, key: pki.clientKeyPem, ca: pki.caPem };
			const res = await dialAgent(
				registered as PublicationHostRecord,
				tls,
				{ method: 'GET', path: '/v1/status' },
				TOKEN,
			);
			expect(res.status).toBe(200);
			expect(agent?.requests.at(-1)?.path).toBe(`${AGENT_BASE_PATH}/v1/status`);
		},
	);

	test.skipIf(!IPV6_LOOPBACK)(
		'a server certificate that names only 127.0.0.1 is refused on identity at [::1] (skipped only where the kernel has no IPv6 loopback)',
		async () => {
			const impostor = startMockAgent(
				{ kind: 'tls', pki: v4OnlyPki, hostname: '::1' },
				'museum_org',
				TOKEN,
			);
			try {
				const host = record('impostor', 'museum_org', {
					kind: 'tls',
					host: '::1',
					port: impostor.port,
				});
				const tls = {
					cert: v4OnlyPki.clientCertPem,
					key: v4OnlyPki.clientKeyPem,
					ca: v4OnlyPki.caPem,
				};
				let failure: unknown = null;
				try {
					await dialAgent(host, tls, { method: 'GET', path: '/health' }, null);
				} catch (error) {
					failure = error;
				}
				expect(isDedaloError(failure) && failure.code).toBe('publication_host.unreachable');
				expect(isDedaloError(failure) && failure.coordinates?.reason).toBe('tls');
				// refused at the TLS layer: not one HTTP request reached the impostor
				expect(impostor.requests.length).toBe(0);
			} finally {
				impostor.stop();
			}
		},
	);
});

// -------------------------------------------------------------- 5. the generic outbound guard

describe("the generic outbound guard's view of the agent's private IPv6", () => {
	test('a ULA and ::1 are refused by assertPublicUrl: only the named agent door reaches them', async () => {
		for (const url of [`https://[${ULA}]:8471${AGENT_BASE_PATH}/health`, `https://[::1]:8471/`]) {
			let failure: unknown = null;
			try {
				await assertPublicUrl(url);
			} catch (error) {
				failure = error;
			}
			expect(isSsrfRefusal(failure), url).toBe(true);
		}
	});
});
