/**
 * The shared SSRF guard's IP-range vetting (SSRF-01/02, 2026-07-28 audit; the IPv6
 * gaps of 2026-09-29).
 *
 * The bug it replaces: per-tool STRING BLOCKLISTS that a private address in any
 * non-canonical form walked straight through. isPrivateIp is the deterministic
 * core; assertPublicUrl is driven here through its `lookup` seam, so no case
 * depends on what the machine's real resolver answers. The fetch primitive on top
 * (fetchPinnedHop, readBytesCapped, the socket pin) has its own gate,
 * pinned_hop_native.test.ts.
 *
 * EVERY BLOCK IS PINNED AT BOTH EDGES where an off-by-one is plausible — the first
 * and last address inside, and the neighbour just outside — because a block that
 * is one bit too wide or too narrow passes every "one address in the middle" test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DedaloError } from '../../src/core/errors/index.ts';
import {
	extractRfc6052Ipv4,
	formatIpv4,
	type PackedCidr,
	packIpv6,
} from '../../src/core/security/ip_address.ts';
import {
	type AddressLookup,
	assertPublicUrl,
	claimedIpv4s,
	embeddedIpv4,
	httpDateMs,
	isAddressRefusal,
	isLoopbackHost,
	isPrivateIp,
	isTunnelIpv6,
	nat64DiscoveryState,
	nextNat64Discovery,
	packBlocks,
	parseRetryAfterMs,
	readBytesCapped,
	SSRF_REFUSAL_KINDS,
	setNat64DiscoveryForTests,
	untilAborted,
} from '../../src/core/security/ssrf_guard.ts';

const NAT64_SETTING = 'DEDALO_NAT64_PREFIXES';
const originalNat64 = process.env[NAT64_SETTING];
/** The process discovery cache as this file found it — restored after every case. */
const originalDiscovery = nat64DiscoveryState();

/**
 * Every case starts with NO declared prefix. Pinned to '' rather than deleted: a
 * deleted process-env key falls back to ../private/.env (readEnv), so an operator
 * who declared a real prefix there would change what these cases judge.
 */
beforeEach(() => {
	process.env[NAT64_SETTING] = '';
});

afterEach(() => {
	if (originalNat64 === undefined) delete process.env[NAT64_SETTING];
	else process.env[NAT64_SETTING] = originalNat64;
	setNat64DiscoveryForTests(originalDiscovery);
});

/** A /96 prefix, packed — what RFC 7050 discovery would have cached. */
function prefix96(network: string): PackedCidr {
	return { network: packIpv6(network) as Uint8Array, prefixBits: 96 };
}

/** Seed the process discovery cache, fresh for the next ten minutes. */
function seedDiscovered(...networks: string[]): void {
	setNat64DiscoveryForTests({
		prefixes: networks.map(prefix96),
		expiresAt: Date.now() + 10 * 60_000,
	});
}

/**
 * Declare NAT64 prefixes for one test (readList resolves process env per call).
 * `undefined` declares none — as '' (see the beforeEach), never by deleting the key.
 */
function declareNat64(value: string | undefined): void {
	process.env[NAT64_SETTING] = value ?? '';
}

/** A resolver seam: a fixed answer per name, `ipv4only.arpa` included. */
function fakeLookup(answers: Record<string, string[]>): AddressLookup {
	return async (host) => {
		const addresses = answers[host];
		if (addresses === undefined) throw new Error(`ENOTFOUND ${host}`);
		return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
	};
}

/** The refusal reason a rejected assertPublicUrl carries (throws if it resolved). */
async function refusalReason(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(DedaloError);
		expect((error as DedaloError).code).toBe('security.ssrf_blocked');
		return String((error as DedaloError).coordinates?.reason);
	}
	throw new Error('expected a refusal, got a pass');
}

describe('isPrivateIp — IPv4', () => {
	test('rejects every private/loopback/link-local/reserved IPv4 form', () => {
		for (const ip of [
			'0.0.0.0',
			'0.255.255.255', // top of "this network"
			'127.0.0.1',
			'127.0.0.2', // the old blocklist only caught 127.0.0.1
			'127.255.255.255',
			'10.1.2.3',
			'172.16.9.9',
			'172.31.255.255',
			'192.168.1.20',
			// Each block's LAST address: a block one bit too narrow lets its top half through.
			'10.255.255.255',
			'192.168.255.255',
			'192.0.2.255',
			'198.51.100.255',
			'203.0.113.255',
			'192.88.99.255',
			'169.254.169.254', // cloud metadata
			'169.254.0.5',
			'100.64.0.1', // CGNAT
			'100.127.255.255', // CGNAT upper edge (a /10, not a /8 or /16)
			'192.0.0.1',
			'192.0.0.170', // RFC 7050's ipv4only.arpa address
			'192.0.2.1', // TEST-NET-1
			'198.51.100.1', // TEST-NET-2
			'203.0.113.1', // TEST-NET-3
			'192.88.99.1', // 6to4 relay anycast
			'198.18.0.1',
			'198.19.255.255', // benchmarking upper edge (a /15)
			'224.0.0.1', // multicast
			'239.255.255.255',
			'240.0.0.1', // reserved
			'250.1.1.1',
			'255.255.255.255', // broadcast
		]) {
			expect(isPrivateIp(ip), `${ip} must be private`).toBe(true);
		}
	});

	test('accepts genuine public IPv4 — including the neighbours just outside each block', () => {
		for (const ip of [
			'8.8.8.8',
			'1.1.1.1',
			'93.184.216.34',
			'9.9.9.9',
			'1.0.0.0', // just past 0/8
			'9.255.255.255', // just before 10/8
			'11.0.0.0', // just past 10/8
			'100.63.255.255', // just before CGNAT
			'100.128.0.0', // just past CGNAT
			'126.255.255.255',
			'128.0.0.0',
			'169.253.255.255',
			'169.255.0.0',
			'172.15.255.255',
			'172.32.0.0',
			'192.0.1.0', // between 192.0.0/24 and TEST-NET-1
			'192.88.98.255',
			'192.167.255.255',
			'192.169.0.0',
			'198.17.255.255',
			'198.20.0.0', // just past the benchmarking /15
			'223.255.255.255', // just below multicast
			// The neighbour just outside each /24 (a block one bit too WIDE swallows it).
			'192.0.3.0',
			'198.51.99.255',
			'198.51.101.0',
			'203.0.112.255',
			'203.0.114.0',
			'192.88.100.0',
		]) {
			expect(isPrivateIp(ip), `${ip} must be public`).toBe(false);
		}
	});

	test('an ambiguous leading-zero literal is refused, never read as decimal', () => {
		expect(isPrivateIp('010.0.0.1')).toBe(true);
		expect(isPrivateIp('8.8.8.08')).toBe(true);
	});
});

describe('isPrivateIp — IPv6', () => {
	test('rejects private/loopback/mapped IPv6 forms', () => {
		for (const ip of [
			'::1',
			'::',
			'::ffff:127.0.0.1', // IPv4-mapped loopback
			'::ffff:192.168.0.1', // IPv4-mapped private
			'fc00::1', // ULA
			'fd12:3456::1', // ULA
			'fe80::1', // link-local
		]) {
			expect(isPrivateIp(ip), `${ip} must be private`).toBe(true);
		}
	});

	test('accepts a public IPv6', () => {
		expect(isPrivateIp('2606:4700:4700::1111')).toBe(false); // Cloudflare
		// Upper-case hex is the same address (a resolver or an operator may write it so);
		// an unparsed spelling would be refused as "not an address".
		expect(isPrivateIp('2606:4700:4700::ABCD')).toBe(false);
		expect(packIpv6('2606:4700:4700::ABCD')).toEqual(packIpv6('2606:4700:4700::abcd'));
		expect(isPrivateIp('2c0f:f248::1')).toBe(false); // AFRINIC space, far from 2001::
		expect(isPrivateIp('2001:200::1')).toBe(false); // just past the refused 2001::/23
		expect(isPrivateIp('3ffe::1')).toBe(false); // 2000::/3's top, below 3fff::/20
		// The neighbours just outside the documentation blocks (a block too WIDE).
		expect(isPrivateIp('2001:db9::1')).toBe(false);
		expect(isPrivateIp('2001:db7:ffff::1')).toBe(false);
		expect(isPrivateIp('3fff:1000::1')).toBe(false);
	});

	/**
	 * The gaps measured 2026-09-29 (PR #114 review): the old check was a BLOCKLIST of
	 * v6 prefixes, and every one of these was read as PUBLIC. Each is given in the
	 * spelling the URL parser actually hands the guard (`new URL(…).hostname`), since
	 * that — not the textbook form — is what arrives.
	 */
	test('rejects every IPv6 form that reaches a private address, in its URL spelling', () => {
		for (const literal of [
			'[::127.0.0.1]', // IPv4-compatible (deprecated) loopback
			'[::ffff:0:7f00:1]', // SIIT spelling of loopback
			'[::ffff:0:a9fe:a9fe]', // SIIT spelling of cloud metadata
			'[64:ff9b::a9fe:a9fe]', // NAT64 → cloud metadata
			'[64:ff9b::127.0.0.1]', // NAT64 → loopback, dotted
			'[64:ff9b:1::5db8:d822]', // local-use NAT64: undeclared ⇒ refused
			'[2002:7f00:1::]', // 6to4 → loopback
			'[2002:a00:1::1]', // 6to4 → 10.0.0.1
			'[2001::1]', // Teredo
			'[2001:2::1]', // benchmarking
			'[2001:20::1]', // ORCHIDv2 — the deliberate 2001::/23 over-block
			'[2001:1ff::1]', // 2001::/23's last /32
			'[2001:db8::1]', // documentation
			'[2001:db8:ffff::1]', // documentation's upper edge (a /32, not a /33)
			'[3fff::1]', // documentation (RFC 9637)
			'[3fff:fff:ffff::1]', // RFC 9637's upper edge (a /20, not a /21)
			'[fec0::1]', // deprecated site-local
			'[ff02::1]', // multicast
			'[100::1]', // discard-only
			'[5f00::1]', // SRv6 SIDs — outside 2000::/3
			'[4000::1]', // just past 2000::/3
			'[1fff:ffff::1]', // just before 2000::/3
			'[0:0:0:0:0:0:0:1]', // loopback, long form
			'[FE80::1]', // link-local, upper case
		]) {
			const host = new URL(`http://${literal}/`).hostname.replace(/^\[|\]$/g, '');
			expect(isPrivateIp(host), `${literal} (arrives as ${host}) must be private`).toBe(true);
		}
	});

	test('6to4 and SIIT are refused WHOLE — a public embedded IPv4 does not rescue them', () => {
		// 6to4's IPv4 is the RELAY (RFC 7526); `2002:a00:101:808:808::` reads "relay
		// 10.0.1.1" and "public 8.8.8.8" depending on which bits you trust.
		for (const ip of [
			'2002:5db8:d822::1', // relay 93.184.216.34
			'2002:a00:101:808:808::',
			'::ffff:0:5db8:d822', // SIIT, obsolete (RFC 2765), not in the IANA registry
			'::ffff:0:808:808',
		]) {
			expect(isPrivateIp(ip), `${ip} must be refused`).toBe(true);
		}
		expect(isTunnelIpv6(packIpv6('2002:5db8:d822::1') as Uint8Array)).toBe(true);
		expect(isTunnelIpv6(packIpv6('2001:0:5db8:d822::') as Uint8Array)).toBe(true); // Teredo
		expect(isTunnelIpv6(packIpv6('2001:1::1') as Uint8Array)).toBe(false);
		expect(isTunnelIpv6(packIpv6('2003::1') as Uint8Array)).toBe(false);
	});

	test('an IPv4-carrying IPv6 address to a PUBLIC host stays public', () => {
		// Mapped and NAT64 are judged by the embedded IPv4: an IPv6-only host with DNS64
		// reaches the whole v4 internet through 64:ff9b::/96.
		for (const ip of [
			'::ffff:93.184.216.34', // mapped, dotted — the text fold must not hide it
			'::ffff:5db8:d822', // mapped, hex
			'64:ff9b::5db8:d822', // NAT64 → 93.184.216.34
		]) {
			expect(isPrivateIp(ip), `${ip} must be public`).toBe(false);
		}
	});

	test('a ZONED address is refused, even a global one', () => {
		// A zone on a global address is meaningless, and the URL hostname setter
		// silently ignores a zoned value — which defeated the socket pin.
		expect(isPrivateIp('2606:4700:4700::1111%eth0')).toBe(true);
		expect(isPrivateIp('fe80::1%eth0')).toBe(true);
	});

	test('a non-IP string is refused (fail closed)', () => {
		expect(isPrivateIp('not-an-ip')).toBe(true);
		expect(isPrivateIp('')).toBe(true);
	});
});

describe('NAT64 network-specific prefixes (RFC 6052 §2.2)', () => {
	/** RFC 6052 §2.4's own table: 192.0.2.33 under each prefix length. */
	const RFC_EXAMPLES: [number, string][] = [
		[32, '2001:db8:c000:221::'],
		[40, '2001:db8:1c0:2:21::'],
		[48, '2001:db8:122:c000:2:2100::'],
		[56, '2001:db8:122:3c0:0:221::'],
		[64, '2001:db8:122:344:c0:2:2100::'],
		[96, '2001:db8:122:344::c000:221'],
	];

	test('the embedded IPv4 is read per RFC 6052 layout, skipping the u octet', () => {
		for (const [prefixBits, address] of RFC_EXAMPLES) {
			const ipv4 = extractRfc6052Ipv4(packIpv6(address) as Uint8Array, prefixBits);
			expect(ipv4 === null ? null : formatIpv4(ipv4), `/${prefixBits}`).toBe('192.0.2.33');
		}
		// No other length has a layout.
		expect(extractRfc6052Ipv4(packIpv6('2001:db8::') as Uint8Array, 36)).toBeNull();
		expect(extractRfc6052Ipv4(Uint8Array.of(1, 2, 3, 4), 96)).toBeNull();
	});

	test('a DECLARED prefix is judged by its IPv4, at every RFC length', () => {
		// The attack: a provider prefix inside 2000::/3 looks public on its v6 face.
		const cases: [string, string, string][] = [
			['2c0f:f248::/32', '2c0f:f248:a9fe:a9fe::', '2c0f:f248:5db8:d822::'],
			['2c0f:f248::/40', '2c0f:f248:a9:fea9:fe::', '2c0f:f248:5d:b8d8:22::'],
			['2c0f:f248::/48', '2c0f:f248:0:a9fe:a9:fe00::', '2c0f:f248:0:5db8:d8:2200::'],
			['2c0f:f248::/56', '2c0f:f248:0:a9:fe:a9fe::', '2c0f:f248:0:5d:b8:d822::'],
			['2c0f:f248::/64', '2c0f:f248::a9:fea9:fe00:0', '2c0f:f248::5d:b8d8:2200:0'],
			['2c0f:f248::/96', '2c0f:f248::a9fe:a9fe', '2c0f:f248::5db8:d822'],
		];
		for (const [prefix, toMetadata, toPublic] of cases) {
			declareNat64(undefined);
			expect(isPrivateIp(toMetadata), `${toMetadata} undeclared looks public`).toBe(false);
			declareNat64(prefix);
			expect(embeddedIpv4(packIpv6(toMetadata) as Uint8Array), prefix).toBe('169.254.169.254');
			expect(isPrivateIp(toMetadata), `${toMetadata} under ${prefix}`).toBe(true);
			expect(isPrivateIp(toPublic), `${toPublic} under ${prefix}`).toBe(false);
		}
	});

	test('a declared prefix is the operator’s word: it may admit a local-use prefix', () => {
		declareNat64('64:ff9b:1::/96, fd00:64::/96');
		expect(isPrivateIp('64:ff9b:1::5db8:d822')).toBe(false);
		expect(isPrivateIp('fd00:64::5db8:d822')).toBe(false);
		expect(isPrivateIp('fd00:64::a00:1')).toBe(true); // → 10.0.0.1
		expect(isPrivateIp('fd00:65::5db8:d822')).toBe(true); // outside the declaration: ULA
	});

	test('an unusable declared prefix fails IPv6 CLOSED, and leaves IPv4 alone', async () => {
		// '192.0.2.0/32' is an IPv4 block at an RFC 6052 LENGTH: only the family check
		// refuses it (a /8 is refused by the length check anyway).
		for (const bad of ['2c0f:f248::/33', '10.0.0.0/8', '192.0.2.0/32', 'nonsense', '2c0f:f248::']) {
			declareNat64(bad);
			expect(isPrivateIp('2606:4700:4700::1111'), bad).toBe(true);
			expect(isPrivateIp('8.8.8.8'), bad).toBe(false);
			expect(await refusalReason(assertPublicUrl('http://[2606:4700:4700::1111]/')), bad).toBe(
				'nat64_config_invalid',
			);
			await assertPublicUrl('http://8.8.8.8/'); // IPv4 unaffected
		}
	});

	test('a DISCOVERED prefix (RFC 7050) only ever TIGHTENS', async () => {
		const target = (address: string): AddressLookup =>
			fakeLookup({
				'nat64.test': [address],
				// The synthesized AAAA of ipv4only.arpa: 192.0.0.170 under 2c0f:f248:64::/96.
				'ipv4only.arpa': ['192.0.0.170', '2c0f:f248:64::c000:aa'],
			});
		const noNat64 = (address: string): AddressLookup =>
			fakeLookup({ 'nat64.test': [address], 'ipv4only.arpa': ['192.0.0.170'] });

		// Undiscovered, the metadata address in the provider prefix looks public…
		await assertPublicUrl('http://nat64.test/', { lookup: noNat64('2c0f:f248:64::a9fe:a9fe') });
		// …discovered, it is refused as the IPv4 it reaches.
		expect(
			await refusalReason(
				assertPublicUrl('http://nat64.test/', { lookup: target('2c0f:f248:64::a9fe:a9fe') }),
			),
		).toBe('private_resolved');
		// A public IPv4 through it still passes.
		await assertPublicUrl('http://nat64.test/', { lookup: target('2c0f:f248:64::5db8:d822') });
	});

	test('a dual-stack name is discovered for if ANY address needs it, not only if all do', async () => {
		// A public A and an AAAA that reaches metadata through the provider's NAT64: the
		// IPv4 alone never needs discovery, so "every address undecided" would skip it
		// and vet the AAAA against an empty cache — and let the metadata route through.
		setNat64DiscoveryForTests({ prefixes: [], expiresAt: Date.now() + 10 * 60_000 });
		const lookup = fakeLookup({
			'dual.test': ['93.184.216.34', '2c0f:f248:64::a9fe:a9fe'],
			'ipv4only.arpa': ['192.0.0.170', '2c0f:f248:64::c000:aa'],
		});
		expect(await refusalReason(assertPublicUrl('http://dual.test/', { lookup }))).toBe(
			'private_resolved',
		);
		// Positive control: the same shape reaching a PUBLIC IPv4 passes.
		const publicLookup = fakeLookup({
			'dual.test': ['93.184.216.34', '2c0f:f248:64::5db8:d822'],
			'ipv4only.arpa': ['192.0.0.170', '2c0f:f248:64::c000:aa'],
		});
		await assertPublicUrl('http://dual.test/', { lookup: publicLookup });
	});

	/**
	 * TIGHTEN-ONLY, where it can actually bite: a prefix already in the PROCESS cache
	 * (a system resolver that lied once). A `lookup`-seamed call never reaches that
	 * path — `discoveredFor` skips discovery for an address the ordinary rules already
	 * refuse — so the cache is seeded directly and the production path is driven.
	 */
	test('a lying resolver’s cached ULA prefix cannot make a ULA address acceptable', async () => {
		seedDiscovered('fd00:64::');
		expect(isPrivateIp('fd00:64::5db8:d822')).toBe(true); // "public 93.184.216.34" — refused
		expect(isPrivateIp('fd00:64::a00:1')).toBe(true);
		expect(await refusalReason(assertPublicUrl('http://[fd00:64::5db8:d822]/'))).toBe(
			'private_literal',
		);
		// …and no fold exported to other checks takes its word either.
		expect(embeddedIpv4(packIpv6('fd00:64::5db8:d822') as Uint8Array)).toBeNull();
	});

	test('a CACHED discovered prefix refuses what it covers, even when discovery is skipped', async () => {
		seedDiscovered('2c0f:f248:64::');
		// The v6 face is public; the cached prefix says it reaches the metadata endpoint.
		expect(isPrivateIp('2c0f:f248:64::a9fe:a9fe')).toBe(true);
		expect(isPrivateIp('2c0f:f248:64::5db8:d822')).toBe(false); // a public IPv4 through it
		expect(await refusalReason(assertPublicUrl('http://[2c0f:f248:64::a9fe:a9fe]/'))).toBe(
			'private_literal',
		);
		// claimedIpv4s reports the discovered claim (for refusing); embeddedIpv4 does not.
		const bytes = packIpv6('2c0f:f248:64::a9fe:a9fe') as Uint8Array;
		expect(claimedIpv4s(bytes)).toEqual(['169.254.169.254']);
		expect(embeddedIpv4(bytes)).toBeNull();
		expect(claimedIpv4s(packIpv6('64:ff9b::a9fe:a9fe') as Uint8Array)).toEqual(['169.254.169.254']);
		expect(claimedIpv4s(Uint8Array.of(169, 254, 169, 254))).toEqual([]);
	});

	/**
	 * NESTED prefixes (two translators, a resolver answering two AAAA, an operator
	 * declaring an outer and an inner prefix): an address both contain is read
	 * through EVERY one of them. The /32 reads 2a00:1:5db8:d822::a9fe:a9fe as the public
	 * 93.184.216.34, the /96 — the more specific, the one routing follows — as the
	 * metadata endpoint. Before 2026-10-21 only the FIRST matching prefix was read,
	 * so the verdict hung on the order the resolver (or the operator) listed them.
	 */
	const NESTED_OUTER = '2a00:1::/32';
	const NESTED_INNER = '2a00:1:5db8:d822::/96';
	const NESTED_TO_METADATA = '2a00:1:5db8:d822::a9fe:a9fe';
	const NESTED_TO_PUBLIC = '2a00:1:5db8:d822::5db8:d822'; // 93.184.216.34 through BOTH

	function seedNested(order: readonly string[]): void {
		setNat64DiscoveryForTests({
			prefixes: order.map((cidr) => packBlocks([cidr])[0] as PackedCidr),
			expiresAt: Date.now() + 10 * 60_000,
		});
	}

	test('NESTED discovered prefixes: every one is read, in either list order', async () => {
		const metadata = packIpv6(NESTED_TO_METADATA) as Uint8Array;
		for (const order of [
			[NESTED_OUTER, NESTED_INNER],
			[NESTED_INNER, NESTED_OUTER],
		]) {
			seedNested(order);
			expect(isPrivateIp(NESTED_TO_METADATA), order.join(' then ')).toBe(true);
			expect(claimedIpv4s(metadata), order.join(' then ')).toContain('169.254.169.254');
			expect(
				await refusalReason(assertPublicUrl(`http://[${NESTED_TO_METADATA}]/`)),
				order.join(' then '),
			).toBe('private_literal');
			// Positive control: public through both prefixes still passes.
			expect(isPrivateIp(NESTED_TO_PUBLIC), order.join(' then ')).toBe(false);
		}
	});

	test('NESTED declared prefixes: every one is read; the fold follows the most specific', () => {
		const metadata = packIpv6(NESTED_TO_METADATA) as Uint8Array;
		for (const declared of [
			`${NESTED_OUTER}, ${NESTED_INNER}`,
			`${NESTED_INNER}, ${NESTED_OUTER}`,
		]) {
			declareNat64(declared);
			expect(isPrivateIp(NESTED_TO_METADATA), declared).toBe(true);
			expect(claimedIpv4s(metadata), declared).toContain('169.254.169.254');
			// The fold says where the packet GOES: longest-prefix match, the /96.
			expect(embeddedIpv4(metadata), declared).toBe('169.254.169.254');
			expect(isPrivateIp(NESTED_TO_PUBLIC), declared).toBe(false);
		}
		// Control: the outer declaration alone reads the public IPv4 and accepts.
		declareNat64(NESTED_OUTER);
		expect(isPrivateIp(NESTED_TO_METADATA)).toBe(false);
	});

	test('a DISCOVERED prefix inside a DECLARED one still tightens (refusal is never lost)', () => {
		declareNat64(NESTED_OUTER);
		seedNested([NESTED_INNER]);
		expect(isPrivateIp(NESTED_TO_METADATA)).toBe(true);
		expect(claimedIpv4s(packIpv6(NESTED_TO_METADATA) as Uint8Array)).toContain('169.254.169.254');
		// …and the authoritative fold does not take the resolver's word.
		expect(embeddedIpv4(packIpv6(NESTED_TO_METADATA) as Uint8Array)).toBe('93.184.216.34');
		expect(isPrivateIp(NESTED_TO_PUBLIC)).toBe(false);
	});

	test('the discovery cache: an answer replaces, an EMPTY answer keeps (tighten-only)', () => {
		const known = [{ network: packIpv6('2c0f:f248:64::') as Uint8Array, prefixBits: 96 }];
		const other = [{ network: packIpv6('2c0f:f249::') as Uint8Array, prefixBits: 64 }];
		const replaced = nextNat64Discovery({ prefixes: known, expiresAt: 0 }, other, 1_000);
		expect(replaced.prefixes).toBe(other);
		const kept = nextNat64Discovery({ prefixes: known, expiresAt: 0 }, [], 1_000);
		expect(kept.prefixes).toBe(known); // a resolver hiccup does not reopen the prefix
		// …and an empty answer is re-asked SOONER than a real one is trusted.
		expect(kept.expiresAt).toBeGreaterThan(1_000);
		expect(kept.expiresAt).toBeLessThan(replaced.expiresAt);
		// The documented numbers, pinned literally: ten minutes, one minute.
		expect(replaced.expiresAt).toBe(1_000 + 10 * 60_000);
		expect(kept.expiresAt).toBe(1_000 + 60_000);
	});

	test('the discovery CACHE: TTL honoured, one shared flight, refreshed when expired', async () => {
		let asked = 0;
		const refresh: AddressLookup = async (host) => {
			asked++;
			expect(host).toBe('ipv4only.arpa');
			await Promise.resolve();
			return [{ address: '2c0f:f248:64::c000:aa', family: 6 }];
		};
		// Fresh: no lookup at all.
		seedDiscovered('2c0f:f248:65::');
		await assertPublicUrl('http://[2606:4700:4700::1111]/', { cacheRefreshLookup: refresh });
		expect(asked).toBe(0);
		// Expired: concurrent first calls share ONE lookup, and its answer is cached.
		setNat64DiscoveryForTests({ prefixes: [], expiresAt: 0 });
		await Promise.all([
			assertPublicUrl('http://[2606:4700:4700::1111]/', { cacheRefreshLookup: refresh }),
			assertPublicUrl('http://[2606:4700:4700::2222]/', { cacheRefreshLookup: refresh }),
		]);
		expect(asked).toBe(1);
		const state = nat64DiscoveryState();
		expect(state.expiresAt).toBeGreaterThan(Date.now());
		// The synthesized AAAA itself, read under the /96 layout that holds 192.0.0.170.
		expect(state.prefixes).toEqual([
			{ network: packIpv6('2c0f:f248:64::c000:aa') as Uint8Array, prefixBits: 96 },
		]);
		// …which now refuses what it covers, through the cache alone.
		expect(isPrivateIp('2c0f:f248:64::a9fe:a9fe')).toBe(true);
		// The flight is over: a later expiry asks again.
		setNat64DiscoveryForTests({ prefixes: state.prefixes, expiresAt: 0 });
		await assertPublicUrl('http://[2606:4700:4700::1111]/', { cacheRefreshLookup: refresh });
		expect(asked).toBe(2);
	});

	test('discovery is asked ONLY for an IPv6 address that would pass without it', async () => {
		const asked: string[] = [];
		const recording: AddressLookup = async (host) => {
			asked.push(host);
			return fakeLookup({
				'v4.test': ['93.184.216.34'],
				'ula.test': ['fd00::1'],
				'v6.test': ['2606:4700:4700::1111'],
				'ipv4only.arpa': ['192.0.0.170'],
			})(host);
		};
		await assertPublicUrl('http://v4.test/', { lookup: recording });
		await refusalReason(assertPublicUrl('http://ula.test/', { lookup: recording }));
		expect(asked).toEqual(['v4.test', 'ula.test']); // nothing discovery could change
		await assertPublicUrl('http://v6.test/', { lookup: recording });
		expect(asked).toEqual(['v4.test', 'ula.test', 'v6.test', 'ipv4only.arpa']);
	});

	test('a `lookup`-seamed call leaves the process cache untouched', async () => {
		const before = { prefixes: [], expiresAt: 0 };
		setNat64DiscoveryForTests(before);
		await assertPublicUrl('http://nat64.test/', {
			lookup: fakeLookup({
				'nat64.test': ['2c0f:f248:64::5db8:d822'],
				'ipv4only.arpa': ['2c0f:f248:64::c000:aa'],
			}),
		});
		expect(nat64DiscoveryState()).toBe(before);
	});

	test('a discovery lookup that hangs is abandoned after its timeout; the empty answer keeps the old prefixes', async () => {
		const kept = [prefix96('2c0f:f248:64::')];
		setNat64DiscoveryForTests({ prefixes: kept, expiresAt: 0 });
		const started = Date.now();
		await assertPublicUrl('http://[2606:4700:4700::1111]/', {
			cacheRefreshLookup: () => new Promise(() => {}),
		});
		const waited = Date.now() - started;
		expect(waited).toBeGreaterThanOrEqual(1_900);
		expect(waited).toBeLessThan(4_000);
		expect(nat64DiscoveryState().prefixes).toBe(kept);
		expect(nat64DiscoveryState().expiresAt).toBeGreaterThan(Date.now());
	}, 8_000);

	test('discovery reads the /48 layout too (the u octet is skipped)', async () => {
		// 192.0.0.171 under 2c0f:f248:64::/48: c0 00 | u | 00 ab.
		const lookup = fakeLookup({
			'nat64.test': ['2c0f:f248:64:a9fe:a9:fe00::'],
			'ipv4only.arpa': ['2c0f:f248:64:c000:0:ab00::'],
		});
		expect(await refusalReason(assertPublicUrl('http://nat64.test/', { lookup }))).toBe(
			'private_resolved',
		);
	});
});

describe('assertPublicUrl — reasons, through the lookup seam', () => {
	test('each refusal names its reason', async () => {
		const lookup = fakeLookup({
			localhost: ['127.0.0.1'],
			'mixed.test': ['93.184.216.34', '10.0.0.1'], // ONE bad record refuses the name
			'empty.test': [],
			'zoned.test': ['2606:4700:4700::1111%eth0'],
		});
		const reason = (url: string) => refusalReason(assertPublicUrl(url, { lookup }));
		expect(await reason('http://localhost/')).toBe('private_resolved');
		expect(await reason('http://mixed.test/')).toBe('private_resolved');
		expect(await reason('http://127.0.0.1/')).toBe('private_literal');
		expect(await reason('http://[::1]/')).toBe('private_literal');
		expect(await reason('http://missing.test/')).toBe('dns_failed');
		expect(await reason('http://empty.test/')).toBe('no_addresses');
		expect(await reason('http://zoned.test/')).toBe('zone_id');
		expect(await reason('ftp://example.org/')).toBe('protocol');
		expect(await reason('not a url')).toBe('unparseable');
	});

	test('a public name resolves to its vetted addresses, in resolver order', async () => {
		const lookup = fakeLookup({ 'ok.test': ['2606:4700:4700::1111', '93.184.216.34'] });
		const result = await assertPublicUrl('https://ok.test/a?b=1', { lookup });
		expect(result.addresses).toEqual(['2606:4700:4700::1111', '93.184.216.34']);
		expect(result.url.hostname).toBe('ok.test');
	});

	test('isAddressRefusal separates address refusals from URL-shape ones', async () => {
		const lookup = fakeLookup({
			localhost: ['127.0.0.1'],
			'zoned.test': ['fe80::1%lo0'],
			'empty.test': [],
		});
		const caught = async (url: string): Promise<unknown> =>
			assertPublicUrl(url, { lookup }).then(
				() => undefined,
				(error: unknown) => error,
			);
		for (const url of [
			'http://localhost/',
			'http://10.0.0.1/',
			'http://nope.test/',
			'http://zoned.test/',
			'http://empty.test/', // no_addresses
		]) {
			expect(isAddressRefusal(await caught(url)), url).toBe(true);
		}
		for (const url of ['ftp://example.org/', 'not a url']) {
			expect(isAddressRefusal(await caught(url)), url).toBe(false);
		}
		declareNat64('nonsense');
		const misconfigured = await caught('http://[2606:4700:4700::1111]/');
		expect((misconfigured as DedaloError).coordinates?.reason).toBe('nat64_config_invalid');
		expect(isAddressRefusal(misconfigured)).toBe(true);
		declareNat64(undefined);
		expect(isAddressRefusal(new Error('private_literal'))).toBe(false);
		expect(
			isAddressRefusal(
				new DedaloError('security.outbound_failed', { coordinates: { reason: 'private_literal' } }),
			),
		).toBe(false);
	});

	test('isAddressRefusal answers by the guard’s one reason table, for every reason in it', () => {
		const kinds = Object.entries(SSRF_REFUSAL_KINDS);
		expect(kinds.map(([, kind]) => kind).sort()).toContain('shape');
		for (const [reason, kind] of kinds) {
			const refusal = new DedaloError('security.ssrf_blocked', { coordinates: { reason } });
			expect(isAddressRefusal(refusal), reason).toBe(kind === 'address');
		}
		// A reason outside the table is not an address refusal (nor an own-property trap).
		for (const reason of ['constructor', 'toString', 'mystery']) {
			const refusal = new DedaloError('security.ssrf_blocked', { coordinates: { reason } });
			expect(isAddressRefusal(refusal), reason).toBe(false);
		}
	});
});

describe('guard constants and the capped reader', () => {
	test('packBlocks fails LOUDLY on a constant that does not parse', () => {
		expect(() => packBlocks(['nonsense/8'])).toThrow();
		expect(() => packBlocks(['10.0.0.0/33'])).toThrow();
		expect(packBlocks(['10.0.0.0/8'])).toHaveLength(1);
	});

	test('an already-aborted signal wins over a body that is ready to read', async () => {
		const stopped = AbortSignal.abort(new Error('deadline'));
		let outcome = 'resolved';
		await readBytesCapped(new Response('abc'), 10, { signal: stopped }).catch(() => {
			outcome = 'rejected';
		});
		expect(outcome).toBe('rejected');
		const read = await readBytesCapped(new Response('abc'), 10, {});
		expect(new TextDecoder().decode(read.bytes)).toBe('abc');
	});
});

describe('parseRetryAfterMs — the one Retry-After reader', () => {
	test('digits are seconds; an HTTP-date is the time until it; unclamped', () => {
		expect(parseRetryAfterMs('30', 0)).toBe(30_000);
		expect(parseRetryAfterMs(' 0 ', 0)).toBe(0);
		expect(parseRetryAfterMs('86400', 0)).toBe(86_400_000); // each door clamps
		const now = Date.parse('Tue, 29 Sep 2026 10:00:00 GMT');
		expect(parseRetryAfterMs('Tue, 29 Sep 2026 10:00:20 GMT', now)).toBe(20_000);
		expect(parseRetryAfterMs('Tue, 29 Sep 2026 09:00:00 GMT', now)).toBe(0); // past: now
	});

	test('anything else is null — never a lenient date, never a fraction or hex', () => {
		for (const value of [null, '', 'soon', '1.5', '0x10', '-1', '1e3', '+5']) {
			expect(parseRetryAfterMs(value, 0), String(value)).toBeNull();
		}
	});

	/** The three HTTP-date forms RFC 9110 §5.6.7 says a recipient MUST accept, one instant. */
	const NOW = Date.parse('2026-09-29T12:00:00Z');
	const THIRTY_SECONDS_LATER = [
		'Tue, 29 Sep 2026 12:00:30 GMT', // IMF-fixdate
		'Tuesday, 29-Sep-26 12:00:30 GMT', // RFC 850
		'Tue Sep 29 12:00:30 2026', // asctime — zone-less, and still UTC
	];

	test('all three HTTP-date forms are read, each as UTC, whatever the host time zone', () => {
		// bun test runs in UTC WITHOUT setting TZ: deleting the key would drop every
		// later file in this process back to the host's zone, so restore the zone in effect
		const zone = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
		try {
			for (const tz of ['UTC', 'Europe/Madrid', 'America/New_York', 'Asia/Tokyo']) {
				process.env.TZ = tz;
				for (const value of THIRTY_SECONDS_LATER) {
					expect(parseRetryAfterMs(value, NOW), `${value} @ ${tz}`).toBe(30_000);
				}
			}
		} finally {
			process.env.TZ = zone;
		}
		expect(parseRetryAfterMs('Tue Sep  1 12:00:30 2026', NOW)).toBe(0); // asctime's padded day
	});

	test('an HTTP-date is read EXACTLY: every month name, every clock field', () => {
		expect(httpDateMs('Thu, 31 Dec 2026 23:59:59 GMT', 0)).toBe(Date.UTC(2026, 11, 31, 23, 59, 59));
		expect(httpDateMs('Thu, 01 Oct 2026 10:17:42 GMT', 0)).toBe(Date.UTC(2026, 9, 1, 10, 17, 42));
		const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
		months.push('Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec');
		months.forEach((month, index) => {
			expect(httpDateMs(`Mon, 01 ${month} 2029 00:01:00 GMT`, 0), month).toBe(
				Date.UTC(2029, index, 1, 0, 1),
			);
		});
		// RFC 850's century, as an instant: 77 is 1977, 76 is 2076 (from 2026).
		expect(httpDateMs('Wednesday, 29-Sep-77 12:30:00 GMT', NOW)).toBe(
			Date.UTC(1977, 8, 29, 12, 30),
		);
		expect(httpDateMs('Tuesday, 29-Sep-76 12:30:00 GMT', NOW)).toBe(Date.UTC(2076, 8, 29, 12, 30));
	});

	test("RFC 850's two-digit year: more than 50 years ahead means the century before", () => {
		expect(parseRetryAfterMs('Sunday, 06-Nov-94 08:49:37 GMT', NOW)).toBe(0); // 1994, past
		expect(parseRetryAfterMs('Monday, 29-Sep-76 12:00:00 GMT', NOW)).toBe(
			Date.UTC(2076, 8, 29, 12) - NOW,
		);
		expect(parseRetryAfterMs('Tuesday, 29-Sep-77 12:00:00 GMT', NOW)).toBe(0); // 1977
	});

	test('a value only SHAPED like a date is null: no zone, bad field, or loose text', () => {
		for (const value of [
			'Mon 5',
			'Tue, 29 Sep 2026 12:00:30', // IMF without GMT: a local time we cannot know
			'Tue, 29 Sep 2026 12:00:30 CET',
			'Tue, 31 Feb 2026 12:00:30 GMT', // no such day
			'Tue, 00 Sep 2026 12:00:30 GMT',
			'Tue, 29 Sep 2026 24:00:00 GMT',
			'Tue, 29 Sep 2026 12:60:00 GMT',
			'Tue, 29 Sep 2026 12:00:61 GMT',
			'Tue, 29 Sop 2026 12:00:30 GMT', // no such month
			'Tue Sep 29 12:00:30 2026 GMT', // asctime carries no zone
			'29 Sep 2026 12:00:30 GMT',
		]) {
			expect(parseRetryAfterMs(value, NOW), value).toBeNull();
		}
		expect(parseRetryAfterMs('Tue, 29 Sep 2026 12:00:60 GMT', NOW)).toBe(60_000); // leap second
	});
});

describe('untilAborted — the one race against a stop', () => {
	/** A signal whose listener count is observable. */
	function countedSignal(): { signal: AbortSignal; abort: () => void; listeners: () => number } {
		const controller = new AbortController();
		let live = 0;
		const add = controller.signal.addEventListener.bind(controller.signal);
		const remove = controller.signal.removeEventListener.bind(controller.signal);
		Object.assign(controller.signal, {
			addEventListener: (...args: Parameters<AbortSignal['addEventListener']>) => {
				live++;
				add(...args);
			},
			removeEventListener: (...args: Parameters<AbortSignal['removeEventListener']>) => {
				live--;
				remove(...args);
			},
		});
		return { signal: controller.signal, abort: () => controller.abort(), listeners: () => live };
	}

	test('work wins, rejects, or the stop wins — and no listener outlives the call', async () => {
		const job = countedSignal();
		expect(await untilAborted(Promise.resolve(7), job.signal)).toBe(7);
		expect(job.listeners()).toBe(0);
		await expect(untilAborted(Promise.reject(new Error('boom')), job.signal)).rejects.toThrow(
			'boom',
		);
		expect(job.listeners()).toBe(0);
		const pending = untilAborted(new Promise(() => {}), job.signal, () => new Error('stopped'));
		job.abort();
		await expect(pending).rejects.toThrow('stopped');
		expect(job.listeners()).toBe(0);
		// No signal: the work as it is.
		expect(await untilAborted(Promise.resolve('x'), undefined)).toBe('x');
	});
});

describe('isLoopbackHost — packed bytes, every spelling', () => {
	test('loopback in every coat', () => {
		for (const host of [
			'localhost',
			'localhost.',
			'api.localhost',
			'127.0.0.1',
			'127.5.5.5',
			'0.0.0.0',
			'[::1]',
			'[::]',
			'[0:0:0:0:0:0:0:1]',
			'[::ffff:7f00:1]', // what the URL parser makes of ::ffff:127.0.0.1
			'[64:ff9b::7f00:1]', // NAT64 to loopback
			'::1',
		]) {
			expect(isLoopbackHost(host), host).toBe(true);
		}
	});

	test('a private-but-reachable address is NOT loopback', () => {
		for (const host of [
			'10.0.0.1',
			'192.168.1.5',
			'128.0.0.1',
			'[::2]',
			'[::ffff:a00:1]',
			'[2001:db8::1]',
			'[64:ff9b::a00:1]',
			'example.org',
			// Near misses: one byte off `::1`, and a public name's fully-qualified spelling.
			'[100::1]',
			'[::100]',
			'example.org.',
		]) {
			expect(isLoopbackHost(host), host).toBe(false);
		}
	});
});
