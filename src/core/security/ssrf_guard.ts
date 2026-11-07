/**
 * Shared SSRF guard for OUTBOUND-to-internet fetches (SSRF-01/SSRF-02,
 * 2026-07-28 audit; PHP `is_safe_remote_url`).
 *
 * The previous per-tool guards were STRING BLOCKLISTS ("host !== '127.0.0.1'
 * && !/^10\./…"), trivially bypassed by `[::1]`, `127.0.0.2`, `0.0.0.0`,
 * decimal/octal IP literals, IPv4-mapped IPv6, or ANY DNS name pointing at an
 * internal address. This guard instead:
 *   1. requires http/https;
 *   2. RESOLVES the hostname (so a public name pointing at 169.254.169.254 or
 *      127.0.0.1 is caught);
 *   3. vets EVERY resolved address — and an IP literal host — against the full
 *      private / loopback / link-local / reserved range set (v4 and v6), on the
 *      PACKED bytes (ip_address.ts), so no spelling of an address differs from
 *      another.
 *
 * DNS REBINDING (a hostile resolver answering "public" to the check and
 * "127.0.0.1" to the socket) is closed by PINNING the socket to the vetted
 * address: `pinToVettedAddress`, used by `fetchPinnedHop` here — and so by
 * `fetchGuardedText`, which is that hop used once (SURF-2, 2026-09-30) — and by the
 * external-services door (src/external/transport.ts). Every public-destination
 * door connects to the address it vetted; none resolves the name a second time.
 * REDIRECTS are never followed by this module: `fetchGuardedText` refuses them,
 * and `fetchPinnedHop` hands the `Location` back to its caller, which must vet
 * the next hop as a NEW target (core/harvest/ does exactly that, hop by hop).
 *
 * "WHICH IPv4 DOES THIS ADDRESS REACH" has ONE owner, this module: the verdict
 * reads the authoritative carriers, and `claimedIpv4s` answers for every carrier
 * (tighten-only) so a caller with its own policy needs no carrier table of its own.
 * The on-premise transcriber (core/tools/transcription_local_asr.ts) reads it for
 * every form of its host; PENDING: it still unions a redundant copy of the
 * deprecated/local-use tables into its metadata check, and that copy is to be deleted.
 */

import { lookup as systemDnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { readList } from '../../config/readers.ts';
import { DedaloError } from '../errors/index.ts';
import { currentJobSignal } from '../media/job_scope.ts';
import {
	extractRfc6052Ipv4,
	formatIpv4,
	type PackedCidr,
	packAddress,
	packCidr,
	packedInBlock,
	packIpv4,
	packIpv6,
	RFC6052_PREFIX_LENGTHS,
	sameBytes,
} from './ip_address.ts';

/**
 * The guard's refusals, as ONE registered code. `security.ssrf_blocked` is
 * OPERATOR disclosure on purpose: the wire sentence is the registry's fixed
 * English, and the URL, the protocol, the host and the resolved address ride
 * only as LOG-ONLY `coordinates` — echoing them back would turn a blocked
 * fetch into an internal-network oracle. `Error.message` names the address too,
 * for the LOG only: a caller reports a refusal as `toErrorBody(toDedaloError(error))`,
 * never as `error.message` (a tool that holds a door and reads `.message` is refused
 * by ssrf_one_guard_tripwire).
 */
function ssrfRefusal(message: string, coordinates: SsrfRefusalCoordinates): DedaloError {
	return new DedaloError('security.ssrf_blocked', { message, coordinates });
}

/** A refusal's log-only coordinates: its `reason` is one of `SSRF_REFUSAL_KINDS`' keys. */
interface SsrfRefusalCoordinates {
	reason: SsrfRefusalReason;
	[key: string]: string | number;
}

/**
 * True when an error came from THIS guard's refusal, so a caller can answer with
 * its own stable, non-disclosing message.
 *
 * The guard's own text names the address it refused (`… refused private/reserved
 * address 127.0.0.1`). That is right for the log and wrong for the wire: it hands
 * an unauthenticated caller a probe oracle, and it silently rewrote the `msg` two
 * doors had published for years. Callers catch, ask this, and answer in their own
 * words — the detail stays in the DedaloError for the operator.
 */
export function isSsrfRefusal(error: unknown): boolean {
	return error instanceof DedaloError && error.code === 'security.ssrf_blocked';
}

/**
 * EVERY reason this guard refuses with, and what it is about: WHERE THE ADDRESS
 * LEADS (`address`), or the SHAPE of the URL (`shape` — a public policy fact the
 * caller may state in its own words). A caller that must tell the two apart (the
 * harvesting door answers a URL-shape refusal publicly and keeps an address
 * refusal operator-only) asks `isAddressRefusal` instead of copying these strings.
 *
 * The partition is COMPILER-checked, not hand-kept: `ssrfRefusal` accepts only a
 * `SsrfRefusalReason`, which is this table's key set — so a reason thrown and not
 * classified here does not compile, and cannot drift into "URL shape" unseen.
 */
export const SSRF_REFUSAL_KINDS = Object.freeze({
	unparseable: 'shape',
	protocol: 'shape',
	private_literal: 'address',
	private_resolved: 'address',
	dns_failed: 'address',
	no_addresses: 'address',
	pin_failed: 'address',
	zone_id: 'address',
	nat64_config_invalid: 'address',
} as const satisfies Record<string, 'address' | 'shape'>);

export type SsrfRefusalReason = keyof typeof SSRF_REFUSAL_KINDS;

const ADDRESS_REFUSAL_REASONS: ReadonlySet<string> = new Set(
	Object.entries(SSRF_REFUSAL_KINDS)
		.filter(([, kind]) => kind === 'address')
		.map(([reason]) => reason),
);

/** True when an error is this guard refusing an ADDRESS (see SSRF_REFUSAL_KINDS). */
export function isAddressRefusal(error: unknown): boolean {
	if (!isSsrfRefusal(error)) return false;
	const reason = (error as DedaloError).coordinates?.reason;
	return typeof reason === 'string' && ADDRESS_REFUSAL_REASONS.has(reason);
}

/**
 * The address refusals that say the NAME did not resolve (the resolver failed or answered
 * nothing), as opposed to an address that WAS judged non-public. Both are tagged `address`
 * above — the harvesting door must keep them operator-only — but they are not a policy
 * verdict: a resolver outage or a provider's DNS blip passes, and a caller that tells a
 * transient lookup failure from a block (the geo services, which answer one as a
 * retryable `external.transport` and the other as `external.blocked_host`) asks here
 * instead of copying the reason strings. Typed on `SsrfRefusalReason`, so a reason that
 * is renamed or dropped does not compile.
 */
const UNRESOLVED_REFUSAL_REASONS: ReadonlySet<string> = new Set<SsrfRefusalReason>([
	'dns_failed',
	'no_addresses',
]);

/** True when an error is this guard reporting that a host name did not resolve. */
export function isUnresolvedRefusal(error: unknown): boolean {
	if (!isSsrfRefusal(error)) return false;
	const reason = (error as DedaloError).coordinates?.reason;
	return typeof reason === 'string' && UNRESOLVED_REFUSAL_REASONS.has(reason);
}

/**
 * Pack a constant CIDR table ONCE, at module load, frozen. A literal that does not
 * parse is a defect in the calling file, so it fails the import loudly rather than
 * becoming a block that silently matches nothing. Exported so every address table
 * outside this module (transcription_local_asr's metadata set) packs the same way.
 */
export function packBlocks(blocks: readonly string[]): readonly PackedCidr[] {
	return Object.freeze(
		blocks.map((block) => {
			const packed = packCidr(block);
			if (packed === null) {
				throw new DedaloError('internal.invariant', {
					message: `ssrf_guard: constant CIDR ${block} does not parse`,
				});
			}
			return packed;
		}),
	);
}

/**
 * IPv4 blocks that are not the public internet (IANA special-purpose registry).
 * CIDR text on purpose — a reader can check each against its RFC — packed once
 * here so no request re-parses a constant.
 */
const NON_PUBLIC_IPV4_CIDRS: readonly string[] = Object.freeze([
	'0.0.0.0/8', // "this" network / 0.0.0.0
	'10.0.0.0/8', // private
	'100.64.0.0/10', // CGNAT
	'127.0.0.0/8', // loopback
	'169.254.0.0/16', // link-local (incl. cloud metadata 169.254.169.254)
	'172.16.0.0/12', // private
	'192.0.0.0/24', // IETF protocol assignments
	'192.0.2.0/24', // documentation (TEST-NET-1)
	'192.88.99.0/24', // deprecated 6to4 relay anycast
	'192.168.0.0/16', // private
	'198.18.0.0/15', // benchmarking
	'198.51.100.0/24', // documentation (TEST-NET-2)
	'203.0.113.0/24', // documentation (TEST-NET-3)
	'224.0.0.0/4', // multicast
	'240.0.0.0/4', // reserved, incl. broadcast 255.255.255.255
]);
const NON_PUBLIC_IPV4: readonly PackedCidr[] = packBlocks(NON_PUBLIC_IPV4_CIDRS);

/** True when 4 packed bytes are private / loopback / link-local / reserved. */
function isNonPublicIpv4(bytes: Uint8Array): boolean {
	return NON_PUBLIC_IPV4.some((block) => packedInBlock(bytes, block));
}

/** True when an IPv4 literal is not a public address (unparseable ⇒ refused). */
function isPrivateIpv4(ip: string): boolean {
	const bytes = packIpv4(ip);
	return bytes === null || isNonPublicIpv4(bytes);
}

/**
 * The STANDARDIZED IPv6 blocks that carry an IPv4 address. An address in one of them
 * reaches whatever that IPv4 reaches — through the host's own stack (mapped) or a
 * translator (NAT64) — so it is vetted AS that IPv4, never on its v6 face:
 * `64:ff9b::a9fe:a9fe` is the cloud metadata endpoint on any IPv6-only host with
 * DNS64. Both are /96, so the IPv4 is bytes 12-15 (RFC 6052 §2.2's /96 layout).
 *
 * ABSENT on purpose (so refused, being outside global unicast):
 *   - the deprecated IPv4-compatible `::/96` (`::7f00:1` is loopback);
 *   - the SIIT "IPv4-translated" `::ffff:0:0:0/96` of RFC 2765 — obsoleted by RFC
 *     6145, never in the IANA special-purpose registry, and no stack routes it.
 *     Listing it here (as this table briefly did) would have ACCEPTED
 *     `::ffff:0:5db8:d822` as if it were the public 93.184.216.34;
 *   - the local-use NAT64 prefix `64:ff9b:1::/48` (RFC 8215): which layout it uses
 *     is the network's own choice, so only the operator can declare it
 *     (DEDALO_NAT64_PREFIXES) — and then it is honoured like any other.
 * All three are still CLAIMED (`possibleIpv4s`, for `claimedIpv4s`) — never to accept.
 */
const WELL_KNOWN_IPV4_CARRIER_CIDRS: readonly string[] = Object.freeze([
	'::ffff:0:0/96', // IPv4-mapped (RFC 4291)
	'64:ff9b::/96', // NAT64 well-known prefix (RFC 6052)
]);
const WELL_KNOWN_IPV4_CARRIERS: readonly PackedCidr[] = packBlocks(WELL_KNOWN_IPV4_CARRIER_CIDRS);

/**
 * TUNNELS, refused WHOLE — never judged by an embedded IPv4:
 *   - 6to4 `2002::/16` (RFC 3056, deprecated by RFC 7526): the IPv4 in bits 16-47 is
 *     the tunnel's RELAY endpoint, not the destination. Vetting it as the
 *     destination (the previous shape) accepted `2002:5db8:d822::…` because the relay
 *     looked public, while the packet itself goes wherever the relay forwards it —
 *     and `2002:a00:101:808:808::` reads as "relay 10.0.1.1" and as "public 8.8.8.8"
 *     depending on which bits you trust. Nothing legitimate is published there today.
 *   - Teredo `2001::/32` (RFC 4380): the IPv4 is obfuscated and the protocol is a
 *     tunnel, not a destination. (Also inside the refused `2001::/23` below; listed
 *     here so `isTunnelIpv6` names both tunnels in one place.)
 */
const TUNNEL_IPV6_CIDRS: readonly string[] = Object.freeze(['2002::/16', '2001::/32']);
const TUNNEL_IPV6: readonly PackedCidr[] = packBlocks(TUNNEL_IPV6_CIDRS);

/** Global unicast — the only IPv6 space the public internet routes (RFC 4291). */
const GLOBAL_UNICAST_IPV6_CIDR = '2000::/3';
const GLOBAL_UNICAST_IPV6: PackedCidr = packBlocks([GLOBAL_UNICAST_IPV6_CIDR])[0] as PackedCidr;

/**
 * Special-purpose blocks INSIDE global unicast that are still not a public host.
 *
 * `2001::/23` is refused WHOLE, and that is a deliberate over-block. IANA marks a few
 * of its sub-blocks globally reachable — `2001:1::1/128` (PCP anycast), `2001:1::2/128`
 * (TURN anycast), `2001:3::/32` (AMT), `2001:4:112::/48` (AS112), `2001:20::/28`
 * (ORCHIDv2) and `2001:30::/28` (DRIP) — but every one of them is an anycast service
 * endpoint, a multicast tunnel relay or a cryptographic identifier, never a web origin
 * a catalogue lookup, a translator or a harvest could legitimately name. Carving them
 * out would buy no real destination and would cost a longer, easier-to-get-wrong table
 * inside a security predicate; the benchmarking `2001:2::/48` and Teredo sit right
 * beside them.
 */
const NON_PUBLIC_GLOBAL_IPV6_CIDRS: readonly string[] = Object.freeze([
	'2001::/23', // IETF protocol assignments: Teredo, benchmarking, ORCHID (see above)
	'2001:db8::/32', // documentation
	'3fff::/20', // documentation (RFC 9637)
]);
const NON_PUBLIC_GLOBAL_IPV6: readonly PackedCidr[] = packBlocks(NON_PUBLIC_GLOBAL_IPV6_CIDRS);

/** True when packed IPv6 bytes are inside a 6to4 or Teredo tunnel block. */
export function isTunnelIpv6(bytes: Uint8Array): boolean {
	return TUNNEL_IPV6.some((block) => packedInBlock(bytes, block));
}

/** Global unicast, outside every special-purpose and tunnel block. */
function isPublicGlobalIpv6(bytes: Uint8Array): boolean {
	if (!packedInBlock(bytes, GLOBAL_UNICAST_IPV6)) return false;
	if (isTunnelIpv6(bytes)) return false;
	return !NON_PUBLIC_GLOBAL_IPV6.some((block) => packedInBlock(bytes, block));
}

// ---------------------------------------------------------------------------
// NAT64 network-specific prefixes (RFC 6052 §2.2) — declared and discovered
// ---------------------------------------------------------------------------

/**
 * An IPv6-only host behind a NAT64 translator that uses a NETWORK-SPECIFIC prefix
 * (a provider /32…/96 inside the operator's own global space, not `64:ff9b::/96`)
 * reaches the IPv4 internet — and the IPv4 metadata endpoint — through addresses
 * like `2001:db8:64::a9fe:a9fe`, which sit in global unicast and look public on their
 * v6 face. The guard can only see through them if it knows the prefix, so it learns
 * it two ways:
 *
 *   DECLARED (DEDALO_NAT64_PREFIXES): the operator's word, AUTHORITATIVE — an address
 *   inside is judged wholly as its embedded IPv4, exactly like the well-known prefix.
 *
 *   DISCOVERED (RFC 7050: the AAAA of `ipv4only.arpa`, whose only IPv4s are
 *   192.0.0.170/171): the resolver's word, TIGHTEN-ONLY — an address inside whose
 *   embedded IPv4 is non-public is refused, but a public embedded IPv4 does not
 *   rescue an address the ordinary IPv6 rules refuse. A resolver is not the
 *   operator: one that lied "your NAT64 prefix is fd00::/96" must not be able to
 *   turn every unique-local address into an accepted one.
 */
/** A declared prefix: IPv6, and one of the six lengths RFC 6052 gives a layout. */
function nat64PrefixFrom(entry: string): PackedCidr | null {
	const block = packCidr(entry);
	if (block === null || block.network.length !== 16) return null;
	return RFC6052_PREFIX_LENGTHS.has(block.prefixBits) ? block : null;
}

interface Nat64Declaration {
	readonly prefixes: readonly PackedCidr[];
	/** Entries that do not parse as a usable prefix — any of them fails IPv6 closed. */
	readonly invalid: readonly string[];
}

/**
 * The operator's declared prefixes, read per call through the config readers (the
 * list is tiny and usually empty, and a per-call read keeps this module free of a
 * config snapshot a test or a reload could leave stale).
 */
function declaredNat64(): Nat64Declaration {
	const prefixes: PackedCidr[] = [];
	const invalid: string[] = [];
	for (const entry of readList('DEDALO_NAT64_PREFIXES')) {
		const block = nat64PrefixFrom(entry);
		if (block === null) invalid.push(entry);
		else prefixes.push(block);
	}
	return { prefixes, invalid };
}

/** RFC 7050's well-known name, and the two IPv4s its A records hold (RFC 7050 §2.2). */
const IPV4ONLY_ARPA = 'ipv4only.arpa';
const IPV4ONLY_ADDRESSES: readonly Uint8Array[] = Object.freeze([
	Uint8Array.of(192, 0, 0, 170),
	Uint8Array.of(192, 0, 0, 171),
]);

/** How long a discovery answer is trusted, and how long a lookup may take. */
const NAT64_DISCOVERY_TTL_MS = 10 * 60_000;
const NAT64_DISCOVERY_EMPTY_TTL_MS = 60_000;
const NAT64_DISCOVERY_TIMEOUT_MS = 2_000;

/**
 * THE DISCOVERY CACHE. LIFECYCLE: process-wide, request-INDEPENDENT (it holds the
 * NAT64 prefixes of the network this process sits on — no user, session, language
 * or record), refreshed lazily by `assertPublicUrl` once `expiresAt` passes, and
 * never written by a call that injected its own `lookup` (a test seam must not
 * leave its answer behind) — only by a refresh (`cacheRefreshLookup` chooses the
 * resolver it asks) or by `setNat64DiscoveryForTests`. An empty refresh KEEPS the previous prefixes: they are
 * tighten-only, so a stale one can only refuse more, while dropping it on one
 * resolver hiccup would silently reopen the addresses it covered.
 */
let nat64Discovered: Nat64DiscoveryState = {
	prefixes: [],
	expiresAt: 0,
};

/**
 * The refresh in flight, so concurrent first calls share ONE lookup. LIFECYCLE:
 * set when a refresh starts, cleared in that refresh's own `finally`.
 */
let nat64DiscoveryInFlight: Promise<readonly PackedCidr[]> | null = null;

/** Every RFC 6052 prefix under which a synthesized `ipv4only.arpa` AAAA holds a WKA. */
function nat64PrefixesOf(address: string): PackedCidr[] {
	const bytes = isIP(address) === 6 ? packIpv6(address) : null;
	if (bytes === null) return [];
	return [...RFC6052_PREFIX_LENGTHS]
		.filter((prefixBits) => {
			const ipv4 = extractRfc6052Ipv4(bytes, prefixBits);
			return ipv4 !== null && IPV4ONLY_ADDRESSES.some((known) => sameBytes(known, ipv4));
		})
		.map((prefixBits) => ({ network: bytes, prefixBits }));
}

/**
 * RFC 7050 discovery through `lookup`. Best effort by nature: a network with no DNS64
 * answers with no AAAA at all, which is the common case and not an error, and a
 * resolver that fails — or does not answer within `NAT64_DISCOVERY_TIMEOUT_MS` — is
 * treated the same: the declared key is the authoritative path, discovery only
 * tightens.
 */
async function discoverNat64Prefixes(lookup: AddressLookup): Promise<readonly PackedCidr[]> {
	try {
		const deadline = AbortSignal.timeout(NAT64_DISCOVERY_TIMEOUT_MS);
		const records = await untilAborted(lookup(IPV4ONLY_ARPA), deadline);
		return records.flatMap((record) => nat64PrefixesOf(record.address));
	} catch {
		return [];
	}
}

/** One state of the discovery cache. */
export interface Nat64DiscoveryState {
	readonly prefixes: readonly PackedCidr[];
	readonly expiresAt: number;
}

/**
 * The cache's next state after a refresh found `found` — PURE, and exported for its
 * gate, because the policy is the security-relevant part: an answer replaces the
 * prefixes and is trusted for the long TTL; an EMPTY answer keeps the previous
 * prefixes (tighten-only: a stale one can only refuse more, while dropping it on
 * one resolver hiccup would silently reopen every address it covered) and asks
 * again sooner.
 */
export function nextNat64Discovery(
	previous: Nat64DiscoveryState,
	found: readonly PackedCidr[],
	now: number,
): Nat64DiscoveryState {
	if (found.length > 0) return { prefixes: found, expiresAt: now + NAT64_DISCOVERY_TTL_MS };
	return { prefixes: previous.prefixes, expiresAt: now + NAT64_DISCOVERY_EMPTY_TTL_MS };
}

/** Refresh the process cache through `resolver` (one flight at a time). */
async function refreshNat64Discovery(resolver: AddressLookup): Promise<readonly PackedCidr[]> {
	try {
		const found = await discoverNat64Prefixes(resolver);
		nat64Discovered = nextNat64Discovery(nat64Discovered, found, Date.now());
		return nat64Discovered.prefixes;
	} finally {
		nat64DiscoveryInFlight = null;
	}
}

/**
 * The discovered prefixes to vet with. An injected `lookup` discovers through
 * itself and bypasses the cache in both directions; production reads the cache and
 * refreshes it (through `cacheRefreshLookup`, the system resolver by default) when
 * it has expired.
 */
async function discoveredNat64(deps: GuardDeps): Promise<readonly PackedCidr[]> {
	if (deps.lookup !== undefined) return discoverNat64Prefixes(deps.lookup);
	if (Date.now() < nat64Discovered.expiresAt) return nat64Discovered.prefixes;
	nat64DiscoveryInFlight ??= refreshNat64Discovery(deps.cacheRefreshLookup ?? systemLookup);
	return nat64DiscoveryInFlight;
}

/** The discovery cache as it stands — observability for the gates. */
export function nat64DiscoveryState(): Nat64DiscoveryState {
	return nat64Discovered;
}

/**
 * Replace the discovery cache — TEST ISOLATION ONLY: a gate seeds the prefixes a
 * resolver would have reported (or an expired state, to force a refresh) and
 * restores the previous state afterwards.
 */
export function setNat64DiscoveryForTests(state: Nat64DiscoveryState): void {
	nat64Discovered = state;
}

// ---------------------------------------------------------------------------
// The IPv6 verdict
// ---------------------------------------------------------------------------

/** The IPv4 an address carries, and whether the prefix that says so is trusted. */
interface CarriedIpv4 {
	readonly ipv4: Uint8Array;
	/** Standardized or operator-declared (true), or only resolver-discovered (false). */
	readonly authoritative: boolean;
}

/**
 * EVERY block in `blocks` holding `bytes`, as the IPv4 each carries — MOST SPECIFIC
 * FIRST (longest prefix: the translator routing actually follows).
 *
 * Every one, never the first: prefixes NEST (two translators, a resolver answering
 * two AAAA, an operator declaring an outer and an inner prefix), and the same bytes
 * read through a /32 and a /96 inside it are two different IPv4s. Reading only the
 * first made the verdict hang on list order — `2a00:1:5db8:d822::a9fe:a9fe` was the
 * public 93.184.216.34 through a /32 listed first, the metadata endpoint through the
 * /96 (measured 2026-10-21).
 */
function carriedBy(
	bytes: Uint8Array,
	blocks: readonly PackedCidr[],
	authoritative: boolean,
): CarriedIpv4[] {
	return blocks
		.filter((candidate) => packedInBlock(bytes, candidate))
		.sort((left, right) => right.prefixBits - left.prefixBits)
		.flatMap((block) => {
			const ipv4 = extractRfc6052Ipv4(bytes, block.prefixBits);
			return ipv4 === null ? [] : [{ ipv4, authoritative }];
		});
}

/**
 * Every IPv4 an IPv6 address may reach: the trusted carriers (well-known, declared)
 * most specific first, then the discovered ones.
 */
function carriedIpv4s(bytes: Uint8Array, discovered: readonly PackedCidr[]): CarriedIpv4[] {
	const trusted = [...WELL_KNOWN_IPV4_CARRIERS, ...declaredNat64().prefixes];
	return [...carriedBy(bytes, trusted, true), ...carriedBy(bytes, discovered, false)];
}

/**
 * The AUTHORITATIVE fold: the IPv4 the most specific trusted carrier reads — where
 * the packet goes (longest-prefix match). Null when no trusted carrier holds it.
 */
function authoritativeIpv4(bytes: Uint8Array): Uint8Array | null {
	return carriedIpv4s(bytes, [])[0]?.ipv4 ?? null;
}

/**
 * The IPv4 an IPv4-carrying IPv6 address reaches, through an AUTHORITATIVE carrier
 * only — IPv4-mapped `::ffff:0:0/96`, NAT64 `64:ff9b::/96`, and every DECLARED
 * network-specific prefix — dotted; null for any other address (including 6to4 and
 * Teredo, which are tunnels refused whole, see TUNNEL_IPV6).
 *
 * NEVER through a DISCOVERED prefix. A fold REPLACES the address with its IPv4, so a
 * caller that judges only the fold would let a resolver's word loosen it — a lying
 * "your NAT64 prefix is fd00::/96" would turn `[fd00::808:808]`, a LAN host, into the
 * public 8.8.8.8. What a discovered prefix claims is for refusing only:
 * `claimedIpv4s`.
 *
 * EXPORTED because "which host does this address really reach" is the same trap in
 * every address check, and a second copy is how the first one survived:
 * `transcription_local_asr` refused the cloud metadata endpoint by literal string and
 * let `[64:ff9b::a9fe:a9fe]` past. It replaces `mappedIpv4`, a second regex parser that
 * understood only the mapped prefix.
 */
export function embeddedIpv4(bytes: Uint8Array): string | null {
	if (bytes.length !== 16) return null;
	const ipv4 = authoritativeIpv4(bytes);
	return ipv4 === null ? null : formatIpv4(ipv4);
}

/**
 * The DEPRECATED IPv6 forms that embed an IPv4 in bytes 12-15: IPv4-compatible `::/96`
 * (RFC 4291 §2.5.5.1) and the SIIT "IPv4-translated" `::ffff:0:0:0/96` (RFC 2765). The
 * verdict refuses both (outside global unicast) and the fold never reads them — but an
 * old or odd stack that still honours one puts `[::ffff:0:a9fe:a9fe]` straight onto the
 * metadata endpoint, so a caller that ALLOWS some private space (the on-premise
 * transcriber's exemption) must still see the IPv4 they claim. CLAIMS only.
 */
const DEPRECATED_IPV4_EMBEDDING_CIDRS: readonly string[] = Object.freeze([
	'::/96',
	'::ffff:0:0:0/96',
]);
const DEPRECATED_IPV4_EMBEDDINGS: readonly PackedCidr[] = packBlocks(
	DEPRECATED_IPV4_EMBEDDING_CIDRS,
);

/**
 * RFC 8215's LOCAL-USE NAT64 block, `64:ff9b:1::/48`. A translator's prefix is carved
 * from it at any RFC 6052 length from /48 to /96, so an address inside may carry its
 * IPv4 in ANY of those layouts — which one only the network knows. The verdict refuses
 * the whole block (not global unicast) unless the operator declares a prefix in it;
 * for CLAIMS every layout is read, since each can only add a refusal.
 */
const LOCAL_USE_NAT64_CIDRS: readonly string[] = Object.freeze(['64:ff9b:1::/48']);
const LOCAL_USE_NAT64: readonly PackedCidr[] = packBlocks(LOCAL_USE_NAT64_CIDRS);
const LOCAL_USE_LAYOUTS: readonly number[] = Object.freeze([48, 56, 64, 96]);

/**
 * The guard's CIDR tables AS TEXT, read-only (every array frozen). Exported for ONE
 * reader: a second classifier that cannot import this module — the site-builder
 * daemon's `isPublicAddress` — is pinned to THESE tables by
 * test/unit/site_builder_public_address_differential.test.ts, which probes every block's
 * edges on both sides, so a block added here is compared without anyone copying it.
 * Never a verdict input outside this module: `isPrivateIp` / `assertPublicUrl` judge.
 */
export const SSRF_ADDRESS_TABLES = Object.freeze({
	nonPublicIpv4: NON_PUBLIC_IPV4_CIDRS,
	wellKnownIpv4Carriers: WELL_KNOWN_IPV4_CARRIER_CIDRS,
	tunnelIpv6: TUNNEL_IPV6_CIDRS,
	globalUnicastIpv6: GLOBAL_UNICAST_IPV6_CIDR,
	nonPublicGlobalIpv6: NON_PUBLIC_GLOBAL_IPV6_CIDRS,
	deprecatedIpv4Embeddings: DEPRECATED_IPV4_EMBEDDING_CIDRS,
	localUseNat64: LOCAL_USE_NAT64_CIDRS,
});

function inAnyBlock(bytes: Uint8Array, blocks: readonly PackedCidr[]): boolean {
	return blocks.some((block) => packedInBlock(bytes, block));
}

/**
 * The IPv4s an address MAY reach on a stack that honours a carrier the guard does not
 * trust: the deprecated embeddings' bytes 12-15, and a local-use address read in every
 * layout. Never a verdict input — only `claimedIpv4s`, tighten-only.
 *
 * NONE for an address an AUTHORITATIVE carrier already reads (well-known or DECLARED):
 * the operator's `64:ff9b:1::/48` declaration IS the network's layout, so reading the
 * same bytes at /56, /64 and /96 invents addresses no packet can reach — the zero
 * suffix of a /48 embedding reads as 0.0.0.0 at /96, and a caller that refuses any
 * claimed non-public IPv4 (the transcriber, exemption OFF) would then refuse a
 * declared public address the guard accepts (measured 2026-09-30).
 */
function possibleIpv4s(bytes: Uint8Array): Uint8Array[] {
	if (authoritativeIpv4(bytes) !== null) return [];
	const deprecated = inAnyBlock(bytes, DEPRECATED_IPV4_EMBEDDINGS) ? [bytes.slice(12, 16)] : [];
	const layouts = inAnyBlock(bytes, LOCAL_USE_NAT64) ? LOCAL_USE_LAYOUTS : [];
	return [...deprecated, ...layouts.flatMap((bits) => extractRfc6052Ipv4(bytes, bits) ?? [])];
}

/**
 * EVERY IPv4 any carrier says this address reaches, dotted — standardized (mapped,
 * NAT64 /96), DECLARED, DISCOVERED, and — only where no authoritative carrier reads
 * the address — DEPRECATED (IPv4-compatible, SIIT) and LOCAL-USE in any RFC 6052
 * layout. This module is the ONE owner of "which IPv4 does this
 * address reach": a caller with a policy of its own asks here instead of keeping a
 * second carrier table (two copies drift). The transcriber judges every form this
 * returns — metadata refusal and, exemption OFF, the private-host rule — and still
 * unions a REDUNDANT copy of the deprecated/local-use tables into its metadata check:
 * PENDING deletion.
 *
 * TIGHTEN-ONLY by contract: a caller may refuse an address because one of these is
 * forbidden, never accept it because one is not — only the authoritative fold
 * (`embeddedIpv4`) says where an address GOES; the rest are an untrusted resolver's
 * word (RFC 7050 §7) or a stack's possible reading, exactly as strong as a reason to
 * say no and no stronger. Tunnels (6to4, Teredo) claim nothing: they are refused whole.
 */
export function claimedIpv4s(bytes: Uint8Array): string[] {
	if (bytes.length !== 16) return [];
	const carried = carriedIpv4s(bytes, nat64Discovered.prefixes).map((claim) => claim.ipv4);
	return [...new Set([...carried, ...possibleIpv4s(bytes)].map(formatIpv4))];
}

/**
 * True when an IPv6 address is not a public host.
 *
 * An ALLOWLIST of the routable space rather than a blocklist of known-bad prefixes:
 * outside global unicast (`2000::/3`) everything is refused — loopback, `::`,
 * unique-local, link-local, the deprecated site-local `fec0::/10`, multicast, the
 * IPv4-compatible and SIIT blocks — because a list of bad prefixes is only as good as
 * the last one someone remembered, and that is how `fec0::1`, `ff02::1` and every
 * IPv4-carrying prefix got through before (measured 2026-09-29, PR #114 review).
 *
 * A ZONE ID (`fe80::1%eth0`) is refused outright: a zone on a global address is
 * meaningless, and the URL hostname setter silently IGNORES a zoned value — which
 * turned a socket pin into a no-op that connected to the unvetted name instead.
 *
 * A declared NAT64 prefix that does not parse fails IPv6 CLOSED: the guard cannot
 * tell which v6 addresses reach IPv4 through it, so it refuses them all.
 */
function isPrivateIpv6(ip: string, discovered: readonly PackedCidr[]): boolean {
	const bytes = ip.includes('%') ? null : packIpv6(ip);
	if (bytes === null || declaredNat64().invalid.length > 0) return true;
	return isPrivateIpv6Bytes(bytes, discovered);
}

/**
 * The verdict on a parsed address. An IPv4-carrying address is refused when ANY
 * carrier holding it — well-known, declared or discovered, nested or not — reads a
 * non-public IPv4, whoever says it carries one; only when EVERY reading is public
 * does an authoritative one (standardized or declared) settle it as accepted — the
 * IPv4 IS the destination. Discovered-only readings fall through to the ordinary
 * IPv6 rules, which is what "tighten-only" means.
 */
function isPrivateIpv6Bytes(bytes: Uint8Array, discovered: readonly PackedCidr[]): boolean {
	const carried = carriedIpv4s(bytes, discovered);
	if (carried.some((reading) => isNonPublicIpv4(reading.ipv4))) return true;
	if (carried.some((reading) => reading.authoritative)) return false;
	return !isPublicGlobalIpv6(bytes);
}

/** The verdict with an explicit set of discovered prefixes (assertPublicUrl's seam). */
function isPrivateIpWith(ip: string, discovered: readonly PackedCidr[]): boolean {
	const kind = isIP(ip);
	if (kind === 4) return isPrivateIpv4(ip);
	if (kind === 6) return isPrivateIpv6(ip, discovered);
	return true; // not an IP ⇒ refuse
}

/**
 * True when an already-resolved IP literal is not a public address.
 *
 * SYNCHRONOUS by contract, so it judges with the declared NAT64 prefixes and the
 * ones discovery has ALREADY cached; `assertPublicUrl` is the path that waits for
 * discovery before it vets.
 */
export function isPrivateIp(ip: string): boolean {
	return isPrivateIpWith(ip, nat64Discovered.prefixes);
}

// ---------------------------------------------------------------------------
// Loopback — "nobody else can reach this"
// ---------------------------------------------------------------------------

/** The exact loopback NAMES (the `.localhost` TLD is matched by suffix below). */
const LOOPBACK_NAMES: ReadonlySet<string> = new Set([
	'',
	'localhost',
	'localhost.localdomain',
	'ip6-localhost',
	'ip6-loopback',
]);

/** The loopback NAME family, including the RFC 6761 `.localhost` TLD. */
function isLoopbackName(host: string): boolean {
	// A trailing dot is the FULLY-QUALIFIED spelling of the same name: `localhost.`
	// resolves exactly where `localhost` does, and the URL parser keeps the dot.
	const name = host.endsWith('.') ? host.slice(0, -1) : host;
	return LOOPBACK_NAMES.has(name) || name.endsWith('.localhost');
}

/** All of 127/8 (not merely .1), plus the unspecified 0.0.0.0 — on packed bytes. */
function isLoopbackIpv4Bytes(bytes: Uint8Array): boolean {
	return bytes[0] === 127 || bytes.every((byte) => byte === 0);
}

/** An IPv4 literal on loopback (an unparseable one is not loopback — it is not an address). */
function isLoopbackIpv4(host: string): boolean {
	const bytes = packIpv4(host);
	return bytes !== null && isLoopbackIpv4Bytes(bytes);
}

/** `::1` and `::` — fifteen zero bytes, then 0 or 1. */
function isLoopbackOrUnspecifiedIpv6(bytes: Uint8Array): boolean {
	return bytes.subarray(0, 15).every((byte) => byte === 0) && (bytes[15] ?? 2) <= 1;
}

/** `::1`/`::`, and loopback wearing a v6 coat (`::ffff:127.0.0.1`, `64:ff9b::7f00:1`). */
function isLoopbackIpv6(host: string): boolean {
	const bytes = packIpv6(host.split('%')[0] ?? host); // a zone does not change the answer
	if (bytes === null) return false;
	if (isLoopbackOrUnspecifiedIpv6(bytes)) return true;
	const carried = embeddedIpv4(bytes);
	return carried !== null && isLoopbackIpv4(carried);
}

/**
 * True when a URL HOSTNAME names this machine's own loopback — the "nobody else
 * can reach this" question, which is NOT the same question as isPrivateIp.
 *
 * A LAN address (192.168.x, 10.x) is private but perfectly reachable, and it is
 * a LEGITIMATE advertised origin: the docker museum install fetches its releases
 * from the master over exactly such an address. So callers asking "would this
 * URL be unfetchable from anywhere but here?" must ask THIS, not isPrivateIp.
 *
 * Takes a `URL.hostname`, so it strips the brackets IPv6 literals arrive in —
 * `new URL('http://[::1]/').hostname` is `[::1]`, and every hand-rolled copy of
 * this check so far compared against a bare `'::1'` and so never matched. Judged
 * on PACKED bytes, like every other address question in this module.
 */
export function isLoopbackHost(hostname: string): boolean {
	const host = unbracket(hostname).toLowerCase();
	const kind = isIP(host);
	if (kind === 4) return isLoopbackIpv4(host);
	if (kind === 6) return isLoopbackIpv6(host);
	return isLoopbackName(host);
}

// ---------------------------------------------------------------------------
// assertPublicUrl — resolve + vet
// ---------------------------------------------------------------------------

/** One resolver answer: what `dns.lookup(host, { all: true })` returns. */
export type AddressLookup = (
	host: string,
) => Promise<readonly { address: string; family: number }[]>;

/** Injectable seams. Production supplies none. */
export interface GuardDeps {
	/**
	 * The resolver — for the target AND for RFC 7050 discovery. A call carrying it
	 * bypasses the process-wide discovery cache in both directions.
	 */
	readonly lookup?: AddressLookup;
	/**
	 * The resolver the discovery CACHE refreshes through (default: the system
	 * resolver). Unlike `lookup` it goes THROUGH the cache — TTL, single flight and
	 * all — so a gate can drive the production path without the machine's DNS.
	 */
	readonly cacheRefreshLookup?: AddressLookup;
}

/** The system resolver, every record (A and AAAA). */
const systemLookup: AddressLookup = (host) => systemDnsLookup(host, { all: true });

/** A `URL.hostname` without the brackets an IPv6 literal arrives in. */
function unbracket(hostname: string): string {
	return hostname.replace(/^\[|\]$/g, '');
}

export interface SafeUrlResult {
	url: URL;
	/** The vetted resolved addresses, in resolver order (for socket pinning). */
	addresses: string[];
}

/** Parse and scheme-check, or throw the two URL-SHAPE refusals. */
function parseOutboundUrl(uri: string): URL {
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		throw ssrfRefusal('ssrf: unparseable URL', { reason: 'unparseable' });
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw ssrfRefusal(`ssrf: refused non-http(s) URL (${url.protocol})`, {
			reason: 'protocol',
			protocol: url.protocol,
		});
	}
	return url;
}

/** Resolve ALL records of a name, or throw `dns_failed` / `no_addresses`. */
async function resolveAll(host: string, lookup: AddressLookup): Promise<string[]> {
	let records: readonly { address: string }[];
	try {
		records = await lookup(host);
	} catch {
		throw ssrfRefusal(`ssrf: DNS resolution failed for ${host}`, { reason: 'dns_failed', host });
	}
	if (records.length === 0) {
		throw ssrfRefusal(`ssrf: no addresses for ${host}`, { reason: 'no_addresses', host });
	}
	return records.map((record) => record.address);
}

/** The two reasons a non-public address is refused with. */
type PrivateReason = 'private_literal' | 'private_resolved';

/** The refusal for one non-public address, worded for a literal or a resolved one. */
function privateRefusal(reason: PrivateReason, host: string, address: string): DedaloError {
	if (reason === 'private_literal') {
		return ssrfRefusal(`ssrf: refused private/reserved address ${host}`, { reason, host });
	}
	return ssrfRefusal(`ssrf: ${host} resolves to a private/reserved address (${address})`, {
		reason,
		host,
		address,
	});
}

/** Vet ONE address, throwing the reason that names what is wrong with it. */
function vetAddress(
	host: string,
	address: string,
	reason: PrivateReason,
	discovered: readonly PackedCidr[],
): void {
	if (address.includes('%')) {
		throw ssrfRefusal(`ssrf: refused zoned address ${address}`, { reason: 'zone_id', host });
	}
	const invalid = isIP(address) === 6 ? declaredNat64().invalid : [];
	if (invalid.length > 0) {
		throw ssrfRefusal('ssrf: DEDALO_NAT64_PREFIXES holds an unusable prefix; IPv6 refused', {
			reason: 'nat64_config_invalid',
			host,
			entries: invalid.join(','),
		});
	}
	if (isPrivateIpWith(address, discovered)) throw privateRefusal(reason, host, address);
}

/**
 * Discovery can only TIGHTEN, so it matters only for an IPv6 address that passes
 * WITHOUT it — an IPv4, or an IPv6 already refused, is judged the same either way.
 * Skipping the lookup otherwise keeps `ipv4only.arpa` traffic to the one case that
 * needs it.
 */
async function discoveredFor(
	addresses: readonly string[],
	deps: GuardDeps,
): Promise<readonly PackedCidr[]> {
	const undecided = addresses.some(
		(address) => isIP(address) === 6 && !isPrivateIpWith(address, nat64Discovered.prefixes),
	);
	// Not undecided: keep vetting with what is cached — returning none here would
	// let an address refused only by a cached prefix through.
	return undecided ? discoveredNat64(deps) : nat64Discovered.prefixes;
}

/**
 * Resolve + vet an outbound URL. Throws (fail closed) unless it is http/https
 * AND every resolved address is public. Returns the parsed URL + vetted IPs.
 */
export async function assertPublicUrl(uri: string, deps: GuardDeps = {}): Promise<SafeUrlResult> {
	const url = parseOutboundUrl(uri);
	const host = unbracket(url.hostname);
	const literal = isIP(host) !== 0;
	// DNS name: resolve ALL records and vet every one.
	const addresses = literal ? [host] : await resolveAll(host, deps.lookup ?? systemLookup);
	const discovered = await discoveredFor(addresses, deps);
	const reason = literal ? 'private_literal' : 'private_resolved';
	for (const address of addresses) vetAddress(host, address, reason, discovered);
	return { url, addresses };
}

/** Convenience boolean form for call sites that only branch. */
export async function isPublicUrl(uri: string): Promise<boolean> {
	try {
		await assertPublicUrl(uri);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Retry-After — the ONE reader of a remote's "come back later"
// ---------------------------------------------------------------------------

/**
 * A `Retry-After` value (RFC 9110 §10.2.3) in ms from `now`: `delta-seconds` (digits
 * only — `1.5`, `0x10`, `-1` and `''` are not seconds) or an HTTP-date (a past one is
 * 0). Null when absent or not either form. UNCLAMPED: how long a door is willing to
 * wait is the door's policy (the external door retries within seconds, the harvest
 * pace allows a minute), so each caller applies its own ceiling to the result.
 *
 * An HTTP-date is read by its GRAMMAR (`httpDateMs`), never by `Date.parse`: that is
 * lenient enough to read `Mon 5` or `1.5` as a date, and reads a zone-less date in
 * the HOST's time zone — while every HTTP-date is UTC. A bogus value stays null.
 */
export function parseRetryAfterMs(value: string | null, now: number): number | null {
	const text = value?.trim() ?? '';
	if (/^\d+$/.test(text)) return Number(text) * 1000;
	const at = httpDateMs(text, now);
	return at === null ? null : Math.max(0, at - now);
}

const HTTP_MONTHS = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec',
];
const SHORT_DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const LONG_DAY = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const CLOCK = '(\\d{2}):(\\d{2}):(\\d{2})';
/** `Sun, 06 Nov 1994 08:49:37 GMT` — groups: day, month, year, h, m, s. */
const IMF_FIXDATE = new RegExp(`^${SHORT_DAY}, (\\d{2}) ([A-Z][a-z]{2}) (\\d{4}) ${CLOCK} GMT$`);
/** `Sunday, 06-Nov-94 08:49:37 GMT` (obsolete) — groups: day, month, yy, h, m, s. */
const RFC850_DATE = new RegExp(`^${LONG_DAY}, (\\d{2})-([A-Z][a-z]{2})-(\\d{2}) ${CLOCK} GMT$`);
/** `Sun Nov  6 08:49:37 1994` (obsolete, zone-less but UTC) — groups: month, day, h, m, s, year. */
const ASCTIME_DATE = new RegExp(`^${SHORT_DAY} ([A-Z][a-z]{2}) ([ \\d]\\d) ${CLOCK} (\\d{4})$`);

/** An HTTP-date's fields, as numbers, the month as its three-letter name. */
interface HttpDateParts {
	year: number;
	month: string;
	day: number;
	clock: [number, number, number];
}

/**
 * The instant an HTTP-date names (RFC 9110 §5.6.7), in ms — all three forms a
 * recipient MUST accept, each read as UTC. Null for anything else.
 */
export function httpDateMs(text: string, now: number): number | null {
	const parts = imfFixdateParts(text) ?? rfc850Parts(text, now) ?? asctimeParts(text);
	return parts === null ? null : utcInstant(parts);
}

function imfFixdateParts(text: string): HttpDateParts | null {
	const match = IMF_FIXDATE.exec(text);
	if (match === null) return null;
	const [, day, month, year, ...clock] = match.map(String);
	return { year: Number(year), month: String(month), day: Number(day), clock: clockOf(clock) };
}

/**
 * RFC 850's two-digit year: the year in this century — unless that is more than 50
 * years ahead of `now`, which RFC 9110 says MUST be read as the century before.
 */
function rfc850Parts(text: string, now: number): HttpDateParts | null {
	const match = RFC850_DATE.exec(text);
	if (match === null) return null;
	const [, day, month, yy, ...clock] = match.map(String);
	const thisYear = new Date(now).getUTCFullYear();
	const year = thisYear - (thisYear % 100) + Number(yy);
	return {
		year: year > thisYear + 50 ? year - 100 : year,
		month: String(month),
		day: Number(day),
		clock: clockOf(clock),
	};
}

function asctimeParts(text: string): HttpDateParts | null {
	const match = ASCTIME_DATE.exec(text);
	if (match === null) return null;
	const [, month, day, hour, minute, second, year] = match.map(String);
	return {
		year: Number(year),
		month: String(month),
		day: Number(day),
		clock: clockOf([hour, minute, second]),
	};
}

function clockOf(fields: readonly (string | undefined)[]): [number, number, number] {
	return [Number(fields[0]), Number(fields[1]), Number(fields[2])];
}

/**
 * The UTC instant of `parts`, or null when a field is out of range — `Date.UTC`
 * would silently roll `31 Feb` into March and `25:00` into tomorrow. The date is
 * read back (a rolled day no longer matches); the clock is checked by range (`60`
 * seconds is a leap second, which the IMF grammar allows).
 */
function utcInstant(parts: HttpDateParts): number | null {
	const month = HTTP_MONTHS.indexOf(parts.month);
	const midnight = Date.UTC(parts.year, month, parts.day);
	const [hour, minute, second] = parts.clock;
	const valid = month !== -1 && new Date(midnight).getUTCDate() === parts.day;
	return valid && clockInRange(hour, minute, second)
		? midnight + ((hour * 60 + minute) * 60 + second) * 1000
		: null;
}

function clockInRange(hour: number, minute: number, second: number): boolean {
	return hour < 24 && minute < 60 && second <= 60;
}

// ---------------------------------------------------------------------------
// The capped reader — the ONE streamed byte ceiling
// ---------------------------------------------------------------------------

export interface CappedReadOptions {
	/**
	 * What a body longer than `maxBytes` means. `'error'` (default): the read fails
	 * and the body is cancelled. `'truncate'`: exactly the first `maxBytes` bytes are
	 * kept, the rest is cancelled unread, and `truncated` says so.
	 */
	overflow?: 'error' | 'truncate';
	/** Fail (reason `idle`) when no chunk arrives for this long. Unset: no idle limit. */
	idleTimeoutMs?: number;
	/**
	 * Stop reading the moment this aborts, whether or not the fetch implementation
	 * wired it into the body stream — so a caller's TOTAL deadline covers the body
	 * by construction, not by a transport's courtesy. Rejects with `signal.reason`.
	 */
	signal?: AbortSignal;
	/** The error to throw on breach under `'error'` (a caller's own typed error). */
	onBreach?: (maxBytes: number) => Error;
}

export interface CappedRead {
	bytes: Uint8Array;
	truncated: boolean;
}

/** A cleanup whose failure is not interesting (the stream is being abandoned). */
function ignore(): void {}

/** The primitive's body-cap failure (callers with their own type pass `onBreach`). */
function bodyCapFailure(maxBytes: number): DedaloError {
	return new DedaloError('security.outbound_failed', {
		message: `response exceeds ${maxBytes} bytes`,
		coordinates: { reason: 'body_cap', max_bytes: maxBytes },
	});
}

/** No body byte for `idleMs`: the peer is holding the socket, not sending. */
function idleFailure(idleMs: number): DedaloError {
	return new DedaloError('security.outbound_failed', {
		message: `no response bytes for ${idleMs}ms`,
		coordinates: { reason: 'idle', stage: 'body', idle_ms: idleMs },
	});
}

type BodyReader = ReadableStreamDefaultReader<Uint8Array>;
/** One `read()` outcome: a chunk, or done. */
type BodyChunk = Awaited<ReturnType<BodyReader['read']>>;

/** A promise that rejects (after `onStop`) when `idleMs` pass; its release clears the timer. */
function idleStop(idleMs: number, releases: (() => void)[], onStop: () => void): Promise<never> {
	return new Promise<never>((_, reject) => {
		// Reject BEFORE stopping: cancelling a stream settles its pending read as
		// `done` on the spot, and a race that saw that first would report a
		// truncated body as a complete one.
		const timer = setTimeout(() => {
			reject(idleFailure(idleMs));
			onStop();
		}, idleMs);
		releases.push(() => clearTimeout(timer));
	});
}

/** A promise that rejects with `reason()` (after `onStop`) when `signal` aborts. */
function abortStop(
	signal: AbortSignal,
	releases: (() => void)[],
	onStop: () => void,
	reason: () => unknown = () => signal.reason,
): Promise<never> {
	return new Promise<never>((_, reject) => {
		const stop = (): void => {
			reject(reason()); // before onStop, for the reason idleStop gives
			onStop();
		};
		if (signal.aborted) return stop();
		signal.addEventListener('abort', stop, { once: true });
		releases.push(() => signal.removeEventListener('abort', stop));
	});
}

/**
 * `work`, unless `signal` aborts first — then it rejects with `reason()` (the
 * signal's own reason by default) whether or not whatever produced `work` honours
 * the signal itself. A deadline a misbehaving fetch implementation can ignore is not
 * a deadline. `work` itself is never cancelled (others may be waiting on it too),
 * and the abort listener never outlives the call. No signal: `work` as it is.
 *
 * THE one "race a promise against a stop" primitive — the harvesting door's waits
 * (core/harvest/abort.ts) are this with a typed "the job was stopped" reason.
 */
export async function untilAborted<T>(
	work: Promise<T>,
	signal: AbortSignal | undefined,
	reason?: () => unknown,
): Promise<T> {
	if (signal === undefined) return work;
	const releases: (() => void)[] = [];
	try {
		// The stop FIRST: an already-aborted signal must win over work that happens
		// to be settled too (Promise.race takes the first settled in array order).
		return await Promise.race([abortStop(signal, releases, ignore, reason), work]);
	} finally {
		for (const release of releases) release();
	}
}

/** The next chunk, raced against the idle limit and the abort signal. */
async function readChunk(reader: BodyReader, options: CappedReadOptions): Promise<BodyChunk> {
	const releases: (() => void)[] = [];
	const stops: Promise<never>[] = [];
	// Either stop abandons the stream: cancel it so the socket is released, not leaked.
	const cancel = (): void => {
		reader.cancel().catch(ignore);
	};
	if (options.idleTimeoutMs !== undefined) {
		stops.push(idleStop(options.idleTimeoutMs, releases, cancel));
	}
	if (options.signal !== undefined) stops.push(abortStop(options.signal, releases, cancel));
	try {
		return await Promise.race([...stops, reader.read()]); // stops first, as in untilAborted
	} finally {
		for (const release of releases) release();
	}
}

/** One buffer out of the chunks read so far. */
function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

/** The breach: cancel the rest, then either fail or keep exactly what still fits. */
async function overflowTail(
	reader: BodyReader,
	chunk: Uint8Array,
	room: number,
	maxBytes: number,
	options: CappedReadOptions,
): Promise<Uint8Array> {
	await reader.cancel().catch(ignore);
	if (options.overflow !== 'truncate') {
		throw options.onBreach?.(maxBytes) ?? bodyCapFailure(maxBytes);
	}
	return chunk.subarray(0, room);
}

/**
 * Read a body under a hard, STREAMED ceiling — THE one capped reader, shared by
 * `fetchBoundedText`, `fetchPinnedHop` and the external-services door. The body is
 * cancelled on breach (a hostile peer cannot feed the process past `maxBytes`), and
 * exactly `maxBytes` bytes is still a whole body. See CappedReadOptions for the
 * truncate mode, the idle limit and the abort signal.
 */
export async function readBytesCapped(
	response: Response,
	maxBytes: number,
	options: CappedReadOptions = {},
): Promise<CappedRead> {
	const reader = response.body?.getReader();
	if (reader === undefined) return { bytes: new Uint8Array(0), truncated: false };
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await readChunk(reader, options);
		if (done) return { bytes: concatChunks(chunks, total), truncated: false };
		if (total + value.byteLength > maxBytes) {
			chunks.push(await overflowTail(reader, value, maxBytes - total, maxBytes, options));
			return { bytes: concatChunks(chunks, maxBytes), truncated: true };
		}
		chunks.push(value);
		total += value.byteLength;
	}
}

// ---------------------------------------------------------------------------
// The job's signal and the text doors' options
// ---------------------------------------------------------------------------

/**
 * THE RUNNING JOB'S SIGNAL (media/job_scope.ts), composed with a call's own
 * deadline. Without it a background job that was stopped — or that blew its lane
 * deadline — went on holding the socket to its own timeout, because the abort could
 * not reach past the worker's first await (PERF-11). Composed, never substituted:
 * the transport's byte/time guarantees are the caller's, and the job's cancellation
 * is additional to them.
 */
function withJobSignal(own: AbortSignal, job: AbortSignal | undefined): AbortSignal {
	return job === undefined ? own : AbortSignal.any([own, job]);
}

export interface GuardedFetchOptions {
	/** Max response bytes read before abort (default 25 MiB). */
	maxBytes?: number;
	/** The TOTAL deadline, in ms — resolve, connect, headers and body (default 15s). */
	timeoutMs?: number;
	/**
	 * Extra fetch init (method/headers/body). Redirects are always refused. Through
	 * `fetchGuardedText` ONLY those three keys, the method GET or POST and the body a
	 * string or `URLSearchParams` — what the pinned hop can carry and re-send; anything
	 * else is refused (`request.invalid_data`), never silently dropped.
	 */
	init?: RequestInit;
	/**
	 * Fail over to the next vetted address only when the failure PROVES nothing was sent —
	 * the rule a POST always gets (`mayResend`) — for a GET too. For a caller whose provider
	 * counts requests (the geo services' one-a-second terms): a GET reset after it left would
	 * otherwise reach the provider a second time inside the caller's single slot.
	 */
	resendOnlyUnsent?: boolean;
}

const TEXT_MAX_BYTES = 25 * 1024 * 1024;
const TEXT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// The socket pin
// ---------------------------------------------------------------------------

/** Fetch init with the Bun-only TLS field the socket pin needs. */
export interface PinnedFetchInit extends RequestInit {
	/** SNI + certificate identity, kept at the REAL host while the URL holds an IP. */
	tls?: { serverName?: string };
}

/** Throw `pin_failed` unless `target` now addresses exactly `address`. */
function assertPinned(target: URL, address: string, realHost: string): void {
	const landed = packAddress(unbracket(target.hostname));
	const expected = address.includes('%') ? null : packAddress(address);
	if (landed !== null && expected !== null && sameBytes(landed, expected)) return;
	throw ssrfRefusal(`ssrf: socket pin to ${address} did not take`, {
		reason: 'pin_failed',
		host: realHost,
		address,
	});
}

/**
 * THE socket pin — the one implementation, shared by `fetchPinnedHop` and the
 * external-services door. Points `target` at the VETTED address when its host is a
 * name, keeping the real host for SNI, certificate identity and the Host header;
 * an IP-literal host has nothing to rebind and is left as it is.
 *
 * It then CHECKS ITSELF: `target` must now address exactly `address` (compared as
 * packed bytes), or it throws `security.ssrf_blocked` reason `pin_failed`. The check
 * exists because the URL `hostname` setter fails SILENTLY — handed a value it will
 * not take (a zoned `[fe80::1%25eth0]`) it keeps the old name, and the request would
 * have gone out to the unvetted name, re-resolved, with nothing to say so.
 *
 * The TLS server name drops a trailing root dot (`example.org.` → `example.org`):
 * RFC 6066 §3 sends the HostName "without a trailing dot", and a server that picks
 * its certificate or vhost by SNI would otherwise answer for another name. The Host
 * header keeps the name as the URL wrote it (RFC 9110 allows the dot there).
 */
export function pinToVettedAddress(
	target: URL,
	address: string,
	headers: Headers,
	init: PinnedFetchInit,
): void {
	const realHost = target.hostname;
	if (isIP(unbracket(realHost)) === 0) {
		headers.set('Host', target.host);
		init.tls = { ...init.tls, serverName: realHost.replace(/\.$/, '') };
		target.hostname = isIP(address) === 6 ? `[${address}]` : address;
	}
	assertPinned(target, address, realHost);
}

// ---------------------------------------------------------------------------
// fetchPinnedHop — one vetted, pinned request; the redirect handed back
// ---------------------------------------------------------------------------

/** One request of a hop-by-hop fetch. See `fetchPinnedHop`. */
export interface PinnedHopRequest {
	url: URL;
	method: 'GET' | 'POST';
	headers: Headers;
	/**
	 * Passed to the socket UNCHANGED: a `URLSearchParams` body is re-sendable on the
	 * next vetted address, and Bun sets the form content type from it.
	 */
	body?: string | URLSearchParams;
	/** Max response bytes read (see `overflow`). */
	maxBytes: number;
	/** The TOTAL deadline, in ms: resolve, connect, headers AND body. */
	timeoutMs: number;
	/** Fail (reason `idle`) when no body bytes flow for this long. Default: `timeoutMs`. */
	idleTimeoutMs?: number;
	/**
	 * Ignore the running job's stop signal. For a fetch SHARED by every job that
	 * asks at once (a coalesced robots.txt read): one stopped job must not fail it
	 * for the others. Its own deadline still bounds it.
	 */
	detachedFromJob?: boolean;
	/** A body over `maxBytes`: fail with `body_cap` (default) or keep the first `maxBytes`. */
	overflow?: 'error' | 'truncate';
	/**
	 * Asked once the status and headers are in: false cancels the body UNREAD
	 * (`bodySkipped`). Lets a caller refuse a wrong content type or an error page
	 * without paying for its bytes.
	 */
	acceptBody?: (status: number, headers: Headers) => boolean;
	/**
	 * Move on to the next vetted address only when the failure proves nothing was sent, for a
	 * GET as for a POST (see `GuardedFetchOptions.resendOnlyUnsent`). Default: a GET moves on
	 * after any connect-level failure.
	 */
	resendOnlyUnsent?: boolean;
}

/**
 * What the budget and the reader need of a request — shared by the pinned hop and
 * the unpinned transport (`fetchBoundedText`), so the two cannot drift apart.
 */
type HopLimits = Pick<
	PinnedHopRequest,
	'maxBytes' | 'timeoutMs' | 'idleTimeoutMs' | 'detachedFromJob' | 'overflow' | 'acceptBody'
>;

/** What one hop answered. */
export interface PinnedHopResponse {
	status: number;
	headers: Headers;
	/**
	 * The raw, unresolved `Location` of a 301/302/303/307/308 that carries one; null
	 * for every other answer — including 300, 304 and 305, which are not redirects to
	 * follow, and whose body is read like any other.
	 */
	location: string | null;
	bytes: Uint8Array;
	/** True when `overflow: 'truncate'` cut the body at `maxBytes`. */
	truncated: boolean;
	/** True when the body was cancelled unread (a redirect, or `acceptBody` said no). */
	bodySkipped: boolean;
}

/** Injectable seams for `fetchPinnedHop`. Production supplies none. */
export interface PinnedHopDeps extends GuardDeps {
	readonly fetch?: (url: string, init: PinnedFetchInit) => Promise<Response>;
}

/** The statuses whose `Location` is a redirect to follow (RFC 9110 §15.4). */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** The hop's clock and cancellation: the total deadline, composed with the job's signal. */
interface HopBudget {
	readonly signal: AbortSignal;
	/** A typed failure for `stage`, its reason read off which signal fired. */
	failure(stage: 'resolve' | 'connect' | 'body', cause: unknown): DedaloError;
	close(): void;
}

/** Why a hop gave up: our deadline, the job being stopped, or the network. */
function hopFailureReason(deadline: AbortSignal, job: AbortSignal | undefined): string {
	if (deadline.aborted) return 'timeout';
	return job?.aborted === true ? 'aborted' : 'transport';
}

function openHopBudget(request: HopLimits): HopBudget {
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), request.timeoutMs);
	const job = request.detachedFromJob === true ? undefined : currentJobSignal();
	return {
		signal: withJobSignal(deadline.signal, job),
		failure: (stage, cause) => {
			const reason = hopFailureReason(deadline.signal, job);
			return new DedaloError('security.outbound_failed', {
				message: `hop ${stage} failed (${reason})`,
				coordinates: { reason, stage },
				cause,
			});
		},
		close: () => clearTimeout(timer),
	};
}

/** The request for ONE vetted address: a fresh URL and headers, pinned. */
function pinnedAttempt(
	request: PinnedHopRequest,
	vettedUrl: URL,
	address: string,
	signal: AbortSignal,
): { url: string; init: PinnedFetchInit } {
	const target = new URL(vettedUrl.toString());
	const headers = new Headers(request.headers);
	const init: PinnedFetchInit = { method: request.method, headers, redirect: 'manual', signal };
	if (request.body !== undefined) init.body = request.body;
	pinToVettedAddress(target, address, headers, init);
	return { url: target.toString(), init };
}

/**
 * The socket-open failures: the connection was never established, so not one byte of
 * the request left. Bun reports a refused connection as `ConnectionRefused` (measured,
 * Bun 1.4); the errno spellings cover the unreachable routes. A reset or a close
 * (`ECONNRESET`) is NOT here: it may come after the request was sent.
 */
const NOTHING_SENT_CODES: ReadonlySet<string> = new Set([
	'ConnectionRefused',
	'FailedToOpenSocket',
	'ECONNREFUSED',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'EADDRNOTAVAIL',
]);

/**
 * May a failed attempt be sent AGAIN to the next vetted address? A GET always may
 * (idempotent) — unless the caller asked for `resendOnlyUnsent`, because its provider
 * counts requests and a second one is not free. A POST only when the failure proves
 * nothing was sent — RFC 9110 §9.2.2: a client must not automatically retry a
 * non-idempotent request, and a re-sent `transcribe` POST starts a second (billed) job.
 */
function mayResend(
	request: Pick<PinnedHopRequest, 'method' | 'resendOnlyUnsent'>,
	error: unknown,
): boolean {
	if (request.method === 'GET' && request.resendOnlyUnsent !== true) return true;
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'string' && NOTHING_SENT_CODES.has(code);
}

/**
 * Connect to the first vetted address that answers. A CONNECT-level failure (the
 * fetch rejected before any response) moves on to the next vetted address — a
 * dual-stack name whose AAAA is unreachable from this host must not fail when its A
 * works — but a POST (or a GET that asked for `resendOnlyUnsent`) only when nothing was
 * sent (`mayResend`). Never after an HTTP
 * answer: a 500 is the server speaking, not a dead route. Never after our own signal
 * fired: a deadline or a stopped job ends the hop.
 */
async function connectPinned(
	request: PinnedHopRequest,
	vetted: SafeUrlResult,
	budget: HopBudget,
	fetchImpl: NonNullable<PinnedHopDeps['fetch']>,
): Promise<Response> {
	let lastError: unknown;
	for (const address of vetted.addresses) {
		const attempt = pinnedAttempt(request, vetted.url, address, budget.signal);
		try {
			return await untilAborted(fetchImpl(attempt.url, attempt.init), budget.signal);
		} catch (error) {
			if (budget.signal.aborted || !mayResend(request, error)) {
				throw budget.failure('connect', error);
			}
			lastError = error;
		}
	}
	throw budget.failure('connect', lastError);
}

/** A 301/302/303/307/308 `Location`, or null. */
function redirectLocation(response: Response): string | null {
	return REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
}

/** Read the body under the cap and the idle limit; a non-typed failure is `body`. */
async function readHopBody(
	request: HopLimits,
	response: Response,
	budget: HopBudget,
): Promise<CappedRead> {
	try {
		return await readBytesCapped(response, request.maxBytes, {
			overflow: request.overflow ?? 'error',
			idleTimeoutMs: request.idleTimeoutMs ?? request.timeoutMs,
			signal: budget.signal,
		});
	} catch (error) {
		if (error instanceof DedaloError) throw error; // body_cap / idle, already typed
		throw budget.failure('body', error);
	}
}

/**
 * The address check, INSIDE the hop's budget. The system resolver has no timeout of
 * its own, and a hop waiting on it may be holding its origin's pacing turn — so a
 * resolver that never answers, or a job that is stopped meanwhile, ends the hop like
 * any other stall (`resolve` stage). The lookup itself cannot be cancelled and is
 * left to finish; nothing waits on it. A refusal is the guard's, passed through.
 */
async function vetWithinBudget(
	request: PinnedHopRequest,
	budget: HopBudget,
	deps: PinnedHopDeps,
): Promise<SafeUrlResult> {
	try {
		return await untilAborted(assertPublicUrl(request.url.toString(), deps), budget.signal);
	} catch (error) {
		if (budget.signal.aborted) throw budget.failure('resolve', error);
		throw error;
	}
}

/** Turn the answer into a hop result: redirect / refused body handed back unread. */
async function readHopResponse(
	request: HopLimits,
	response: Response,
	budget: HopBudget,
): Promise<PinnedHopResponse> {
	const { status, headers } = response;
	const location = redirectLocation(response);
	const accepted = location === null && (request.acceptBody?.(status, headers) ?? true);
	if (!accepted) {
		await response.body?.cancel().catch(ignore);
		return {
			status,
			headers,
			location,
			bytes: new Uint8Array(0),
			truncated: false,
			bodySkipped: true,
		};
	}
	const { bytes, truncated } = await readHopBody(request, response, budget);
	return { status, headers, location: null, bytes, truncated, bodySkipped: false };
}

/**
 * ONE vetted request, the socket PINNED to the address that was vetted, and the
 * redirect handed back instead of followed. The primitive under a caller that
 * must follow redirects itself (the harvesting door, core/harvest/) — because a
 * redirect is a NEW target, and only the caller holds the policy (host allowlist,
 * robots, scheme) that each new target must pass again.
 *
 * The public-address check runs HERE, not in the caller, so this can never be
 * called on an unvetted target. And the connection goes to the vetted IP, not the
 * name (`pinToVettedAddress`, self-checked): re-resolving at connect time is exactly
 * the DNS-rebinding window. `fetchGuardedText` is this hop used ONCE, its redirect
 * refused.
 *
 * Bounded: a TOTAL deadline (`timeoutMs`, from the address check's DNS resolution
 * through the last body byte) composed with the running job's signal unless
 * `detachedFromJob`, an idle limit on the body, and a STREAMED byte ceiling. Every
 * failure is typed: `security.ssrf_blocked` for an address refusal,
 * `security.outbound_failed` with `reason` timeout | idle | aborted | transport (and
 * `stage` resolve | connect | body) for the wire, and `reason` body_cap for the
 * ceiling. A non-2xx status is RETURNED, not
 * thrown — for a harvester a 404 or a 403 is an answer the caller reports.
 */
export async function fetchPinnedHop(
	request: PinnedHopRequest,
	deps: PinnedHopDeps = {},
): Promise<PinnedHopResponse> {
	const budget = openHopBudget(request);
	try {
		const vetted = await vetWithinBudget(request, budget, deps);
		const response = await connectPinned(request, vetted, budget, deps.fetch ?? fetch);
		return await readHopResponse(request, response, budget);
	} finally {
		budget.close();
	}
}

// ---------------------------------------------------------------------------
// fetchGuardedText / fetchBoundedText — the single-call text doors
// ---------------------------------------------------------------------------

/** A 3xx whose `Location` a single-call door will not follow, typed. */
function redirectRefusal(status: number): DedaloError {
	return new DedaloError('security.outbound_failed', {
		message: `redirect refused (HTTP ${status})`,
		coordinates: { reason: 'redirect', status },
	});
}

/**
 * Only a 2xx body is worth reading: a text door throws on any other status, so an error
 * page is cancelled UNREAD (`bodySkipped`) — never paid for under the cap and the
 * deadline, and never able to turn `HTTP <n>` into a timeout or a body_cap.
 */
function successBodyOnly(status: number): boolean {
	return status >= 200 && status <= 299;
}

/** A non-2xx answer to a text fetch, typed. */
function httpStatusFailure(status: number): DedaloError {
	return new DedaloError('security.outbound_failed', {
		message: `HTTP ${status}`,
		coordinates: { status },
	});
}

/** The body of a 2xx answer as text; a redirect or any other status is a typed throw. */
function textOfAnswer(answer: PinnedHopResponse): string {
	if (answer.location !== null) throw redirectRefusal(answer.status);
	if (answer.status < 200 || answer.status > 299) throw httpStatusFailure(answer.status);
	return new TextDecoder().decode(answer.bytes);
}

/** A caller's init the pinned hop cannot carry — refused loudly, before any socket. */
function unsupportedInit(what: string): DedaloError {
	return new DedaloError('request.invalid_data', {
		message: `fetchGuardedText: ${what} is not supported (method GET/POST, headers, a string or URLSearchParams body)`,
	});
}

/** GET (the default) or POST; anything else throws. */
function textMethod(method: string | undefined): 'GET' | 'POST' {
	const normalized = (method ?? 'GET').toUpperCase();
	if (normalized === 'GET' || normalized === 'POST') return normalized;
	throw unsupportedInit(`method ${normalized}`);
}

/** No body, a string or `URLSearchParams` — passed through unchanged; anything else throws. */
function textBody(body: RequestInit['body']): string | URLSearchParams | undefined {
	if (body === undefined || body === null) return undefined;
	if (typeof body === 'string' || body instanceof URLSearchParams) return body;
	throw unsupportedInit(`body ${Object.prototype.toString.call(body)}`);
}

/** The init keys the pinned hop carries; any other (a signal, a redirect mode…) would be silently dropped. */
const CARRIED_INIT_KEYS: ReadonlySet<string> = new Set(['method', 'headers', 'body']);

/** Refuse, loudly, an init key the hop would otherwise drop without a word. */
function assertCarriedInit(init: RequestInit): void {
	const dropped = Object.keys(init).filter((key) => !CARRIED_INIT_KEYS.has(key));
	if (dropped.length > 0) throw unsupportedInit(`init ${dropped.join(', ')}`);
}

/** The pinned-hop request a `fetchGuardedText` call stands for. */
function guardedTextRequest(uri: string, options: GuardedFetchOptions): PinnedHopRequest {
	const init = options.init ?? {};
	assertCarriedInit(init);
	const request: PinnedHopRequest = {
		url: parseOutboundUrl(uri),
		method: textMethod(init.method),
		headers: new Headers(init.headers),
		maxBytes: options.maxBytes ?? TEXT_MAX_BYTES,
		timeoutMs: options.timeoutMs ?? TEXT_TIMEOUT_MS,
		acceptBody: successBodyOnly,
	};
	if (options.resendOnlyUnsent === true) request.resendOnlyUnsent = true;
	const body = textBody(init.body);
	if (body !== undefined) request.body = body;
	return request;
}

/**
 * THE PUBLIC-DESTINATION single-call text fetch: vetted, PINNED, bounded, no
 * redirect. It is `fetchPinnedHop` used once — the address check runs inside the hop,
 * the socket connects to the address that was vetted (a hostile resolver answering
 * "public" to the check and "127.0.0.1" to a second lookup gets no second lookup),
 * a TOTAL deadline covers resolve, connect and body, the job's signal is composed in,
 * and the body is read under the streamed ceiling (defaults 25 MiB, 15s).
 *
 * Every failure is typed: `security.ssrf_blocked` for an address refusal;
 * `security.outbound_failed` with `reason` redirect (a 3xx with a `Location` — a
 * redirect re-chooses the target, so a caller that must follow one goes through the
 * harvesting door, core/harvest/), with `status` for any other non-2xx (message
 * `HTTP <n>`, the error page cancelled unread), with `reason` timeout | aborted |
 * transport and its `stage`, or
 * body_cap. A method other than GET/POST, or a body other than a string or
 * `URLSearchParams`, is `request.invalid_data`, thrown before anything leaves.
 *
 * A caller whose destination is legitimately PRIVATE (an on-premise sidecar) must not
 * copy this to get the transport guarantees: it applies its own named address policy
 * and calls `fetchBoundedText` — the same transport core, without the address check
 * and without the pin (CARRY-14: the second copy is how six fetch sites ended up with
 * no timeout, no signal and no byte cap at all).
 */
export async function fetchGuardedText(
	uri: string,
	options: GuardedFetchOptions = {},
	deps: PinnedHopDeps = {},
): Promise<string> {
	return textOfAnswer(await fetchPinnedHop(guardedTextRequest(uri, options), deps));
}

/** Connect by NAME (no pin, no address policy), inside the budget; failures typed. */
async function connectUnpinned(
	url: string,
	init: RequestInit | undefined,
	budget: HopBudget,
): Promise<Response> {
	try {
		// The real fetch honours `budget.signal` itself; there is no seam here for one
		// that would not, so no race is needed (or could be gated).
		return await fetch(url, { ...init, redirect: 'error', signal: budget.signal });
	} catch (error) {
		throw budget.failure('connect', error);
	}
}

/**
 * The transport half of `fetchGuardedText`, on a URL the CALLER has already judged —
 * the SAME core (`openHopBudget`, `readHopResponse`, the typed failures, the job's
 * signal, the streamed ceiling) minus the address check and minus the pin. It refuses
 * any 3xx: a redirect re-chooses the target, and the caller's policy was applied to
 * the target it chose (Bun's `redirect: 'error'` fails the connect; a 3xx that still
 * answers is a typed `status` failure).
 *
 * It applies NO address policy. Every caller must have applied one — see
 * `assertPublicUrl` for the public case and `isSafeLocalAsrUrl` for the
 * config-gated private-host exemption (outbound_fetch_tripwire censuses them).
 */
export async function fetchBoundedText(
	url: string,
	options: GuardedFetchOptions = {},
): Promise<string> {
	const limits: HopLimits = {
		maxBytes: options.maxBytes ?? TEXT_MAX_BYTES,
		timeoutMs: options.timeoutMs ?? TEXT_TIMEOUT_MS,
		acceptBody: successBodyOnly,
	};
	const budget = openHopBudget(limits);
	try {
		const response = await connectUnpinned(url, options.init, budget);
		return textOfAnswer(await readHopResponse(limits, response, budget));
	} finally {
		budget.close();
	}
}
