/**
 * THE ADDRESS VERDICT — "is this address private?" and "is it this machine's own
 * loopback?", PURE and CONFIG-FREE (2026-11-07). Moved out of `ssrf_guard.ts`,
 * which stays the OWNER and the door every caller imports (it re-exports
 * `isPrivateIp` / `isLoopbackHost` / `embeddedIpv4` over these, with the live
 * NAT64 prefixes): this module holds the tables and the verdict so a reader that
 * must not touch the configuration can judge an address with the SAME rule.
 *
 * WHY. The guard reads the operator's declared NAT64 prefixes
 * (`DEDALO_NAT64_PREFIXES`) through src/config/readers.ts, and importing the
 * readers computes src/config/install_state.ts's UNCONFIGURED flag AT IMPORT.
 * The terminal installer validates a public-address answer with the engine's
 * rule (resolve/public_reach_rule.ts) BEFORE it seeds the install's environment
 * (scripts/install_main.ts seedProcessEnv) — reaching the readers from there
 * froze the configuration to its unconfigured sentinels for the whole run.
 * So every NAT64 input here is a PARAMETER ({@link Nat64Context}): the guard
 * passes the declared + discovered prefixes; a config-free caller passes
 * {@link NO_NAT64} (the standardized carriers only — mapped and 64:ff9b::/96).
 *
 * IMPORTS: node:net, ip_address.ts (packed bytes) and the error class only
 * (errors/dedalo_error.ts + its registry — pure, no configuration). Gate:
 * test/unit/no_install_surface_tripwire.test.ts (the installer's import closure).
 */

import { isIP } from 'node:net';
import { DedaloError } from '../errors/dedalo_error.ts';
import {
	extractRfc6052Ipv4,
	formatIpv4,
	type PackedCidr,
	packCidr,
	packedInBlock,
	packIpv4,
	packIpv6,
} from './ip_address.ts';

/**
 * The NAT64 prefixes a verdict reads — the only inputs the guard took from the
 * configuration or the resolver, handed in so this module reads neither.
 */
export interface Nat64Context {
	/** Operator-declared prefixes (DEDALO_NAT64_PREFIXES): AUTHORITATIVE. */
	readonly declared: readonly PackedCidr[];
	/** A declared entry did not parse: every IPv6 fails CLOSED. */
	readonly declaredInvalid: boolean;
	/** Resolver-discovered prefixes (RFC 7050): TIGHTEN-ONLY. */
	readonly discovered: readonly PackedCidr[];
}

/** No declared and no discovered prefix: the standardized carriers only. */
export const NO_NAT64: Nat64Context = Object.freeze({
	declared: Object.freeze([]),
	declaredInvalid: false,
	discovered: Object.freeze([]),
});

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
					message: `address_verdict: constant CIDR ${block} does not parse`,
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
export const NON_PUBLIC_IPV4_CIDRS: readonly string[] = Object.freeze([
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
export function isNonPublicIpv4(bytes: Uint8Array): boolean {
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
export const WELL_KNOWN_IPV4_CARRIER_CIDRS: readonly string[] = Object.freeze([
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
export const TUNNEL_IPV6_CIDRS: readonly string[] = Object.freeze(['2002::/16', '2001::/32']);
const TUNNEL_IPV6: readonly PackedCidr[] = packBlocks(TUNNEL_IPV6_CIDRS);

/** Global unicast — the only IPv6 space the public internet routes (RFC 4291). */
export const GLOBAL_UNICAST_IPV6_CIDR = '2000::/3';
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
export const NON_PUBLIC_GLOBAL_IPV6_CIDRS: readonly string[] = Object.freeze([
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
// The IPv6 verdict
// ---------------------------------------------------------------------------

/** The IPv4 an address carries, and whether the prefix that says so is trusted. */
export interface CarriedIpv4 {
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
export function carriedIpv4s(bytes: Uint8Array, nat64: Nat64Context): CarriedIpv4[] {
	const trusted = [...WELL_KNOWN_IPV4_CARRIERS, ...nat64.declared];
	return [...carriedBy(bytes, trusted, true), ...carriedBy(bytes, nat64.discovered, false)];
}

/**
 * The AUTHORITATIVE fold: the IPv4 the most specific trusted carrier reads — where
 * the packet goes (longest-prefix match). Null when no trusted carrier holds it.
 */
export function authoritativeIpv4(bytes: Uint8Array, nat64: Nat64Context): Uint8Array | null {
	return carriedIpv4s(bytes, { ...nat64, discovered: [] })[0]?.ipv4 ?? null;
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
export function embeddedIpv4In(bytes: Uint8Array, nat64: Nat64Context): string | null {
	if (bytes.length !== 16) return null;
	const ipv4 = authoritativeIpv4(bytes, nat64);
	return ipv4 === null ? null : formatIpv4(ipv4);
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
function isPrivateIpv6(ip: string, nat64: Nat64Context): boolean {
	const bytes = ip.includes('%') ? null : packIpv6(ip);
	if (bytes === null || nat64.declaredInvalid) return true;
	return isPrivateIpv6Bytes(bytes, nat64);
}

/**
 * The verdict on a parsed address. An IPv4-carrying address is refused when ANY
 * carrier holding it — well-known, declared or discovered, nested or not — reads a
 * non-public IPv4, whoever says it carries one; only when EVERY reading is public
 * does an authoritative one (standardized or declared) settle it as accepted — the
 * IPv4 IS the destination. Discovered-only readings fall through to the ordinary
 * IPv6 rules, which is what "tighten-only" means.
 */
function isPrivateIpv6Bytes(bytes: Uint8Array, nat64: Nat64Context): boolean {
	const carried = carriedIpv4s(bytes, nat64);
	if (carried.some((reading) => isNonPublicIpv4(reading.ipv4))) return true;
	if (carried.some((reading) => reading.authoritative)) return false;
	return !isPublicGlobalIpv6(bytes);
}

/**
 * True when an IP literal is not a public address, judged under `nat64` (the
 * guard's `isPrivateIp` passes its declared + discovered prefixes; a config-free
 * caller passes {@link NO_NAT64}).
 */
export function isPrivateIpIn(ip: string, nat64: Nat64Context): boolean {
	const kind = isIP(ip);
	if (kind === 4) return isPrivateIpv4(ip);
	if (kind === 6) return isPrivateIpv6(ip, nat64);
	return true; // not an IP ⇒ refuse
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
function isLoopbackIpv6(host: string, nat64: Nat64Context): boolean {
	const bytes = packIpv6(host.split('%')[0] ?? host); // a zone does not change the answer
	if (bytes === null) return false;
	if (isLoopbackOrUnspecifiedIpv6(bytes)) return true;
	const carried = embeddedIpv4In(bytes, nat64);
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
export function isLoopbackHostIn(hostname: string, nat64: Nat64Context): boolean {
	const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	const kind = isIP(host);
	if (kind === 4) return isLoopbackIpv4(host);
	if (kind === 6) return isLoopbackIpv6(host, nat64);
	return isLoopbackName(host);
}
