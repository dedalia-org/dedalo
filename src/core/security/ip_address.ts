/**
 * IP address literals as BYTES — the one parser every address predicate shares.
 *
 * Every address predicate needs to know what an address literal IS rather than how
 * it is spelled — the outbound SSRF guard and its NAT64 reading (is this
 * resolved address public, and which IPv4 does it carry?), the on-premise
 * transcriber's metadata refusal. An address has many spellings (`::ffff:7f00:1` and
 * `::ffff:127.0.0.1`, `::1` and `0:0:0:0:0:0:0:1`), and every hand-rolled STRING check
 * so far has matched one of them and let the others through. Packed into bytes, they
 * are one value — so every caller asks here, and a spelling cannot reach one and not
 * another.
 *
 * PURE and TOTAL: no imports, no I/O, and every failure is a null or a `false`,
 * never a throw — every caller is a security predicate, where
 * an exception on a hostile input is itself the vulnerability. What "I could not
 * parse it" MEANS (no match, or refuse) is the caller's decision, not this module's.
 */

/**
 * Normalize a block's network text: trim, lowercase, and fold the DOTTED IPv4-mapped
 * form (`::ffff:203.0.113.10`) down to its v4 spelling. TEXT-level and dotted-only on
 * purpose: a hex `::ffff:0:0/96` is an IPv6 block (the SSRF guard's range table) and
 * must stay one. Module-private: callers ask `packCidr`.
 */
function normalizeAddress(value: string): string {
	const trimmed = value.trim().toLowerCase();
	const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(trimmed);
	return mapped?.[1] ?? trimmed;
}

/** Bytes equal, both lengths included — so a 4-byte and a 16-byte value never match. */
export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * One dotted-quad part: a decimal 0-255 with NO leading zero (`0` itself excepted).
 *
 * The leading-zero refusal is deliberate, not pedantry. `inet_aton` and several URL
 * stacks read `010` as OCTAL (8), while a naive decimal read says 10 — so a literal
 * like `127.0.0.01` has two meanings depending on who parses it, and a security
 * predicate must not guess which one the socket will use. The WHATWG URL parser
 * never emits one (it canonicalizes every numeric form to plain decimal) and
 * `node:net` `isIP` refuses them too, so the only spellings this rejects are the
 * ambiguous ones an operator or an attacker typed by hand.
 */
const IPV4_PART = /^(?:0|[1-9]\d{0,2})$/;

/** Pack a dotted-quad into 4 bytes, or null when it is not one. */
export function packIpv4(value: string): Uint8Array | null {
	const parts = value.split('.');
	if (parts.length !== 4) return null;
	const bytes = new Uint8Array(4);
	for (let index = 0; index < 4; index++) {
		const part = parts[index] ?? '';
		if (!IPV4_PART.test(part) || Number(part) > 255) return null;
		bytes[index] = Number(part);
	}
	return bytes;
}

/** The dotted spelling of 4 packed bytes (no validation: they are bytes already). */
export function formatIpv4(bytes: Uint8Array): string {
	return Array.from(bytes.subarray(0, 4)).join('.');
}

/**
 * The hex groups of an IPv6 literal, split around the `::` elision, with any embedded
 * IPv4 tail already packed. Null when the literal is not one.
 *
 * Split out of `packIpv6` deliberately: PARSING an address and WRITING its bytes are two
 * jobs, and doing both in one function made it the most complex in this module — inside a
 * pre-auth security predicate, which is the last place a reader should have to hold two
 * problems at once. Every failure is a null, never a throw: a caller here decides whether
 * to admit an unauthenticated request, so "I could not parse it" must degrade to "no
 * match", not to an exception on the request path.
 *
 * The dotted quad is peeled off the TAIL only — the half the literal ends with — because
 * RFC 4291 §2.2 allows it solely as the FINAL 32 bits. Peeling it off the last group of
 * the whole list (the previous shape) read `1.2.3.4::` as `::1.2.3.4`: a malformed literal
 * accepted as a different, valid address. A dotted group anywhere else is left in the hex
 * list, where the hex-group check refuses it.
 */
function splitIpv6(value: string): {
	head: string[];
	tail: string[];
	v4Tail: Uint8Array;
} | null {
	const halves = ipv6Halves(value);
	if (halves === null) return null;
	const trailing = splitV4Tail(halves.tail);
	if (trailing === null) return null;
	// An embedded v4 tail (`::ffff:203.0.113.10`) occupies TWO groups' worth of bytes.
	const groupCount = halves.head.length + trailing.hexGroups.length + trailing.v4Tail.length / 2;
	if (!ipv6GroupCountValid(groupCount, halves.elided)) return null;
	return { head: halves.head, tail: trailing.hexGroups, v4Tail: trailing.v4Tail };
}

/**
 * Peel an embedded dotted-IPv4 tail off the group list. `v4Tail` is EMPTY (zero bytes,
 * so callers size and write it without a branch) when the last group is plain hex; the
 * whole result is null when it LOOKS like a v4 tail but does not pack as one
 * (`::ffff:1.2.3`), which is a malformed literal, not hex.
 */
function splitV4Tail(groups: string[]): { hexGroups: string[]; v4Tail: Uint8Array } | null {
	const last = groups[groups.length - 1] ?? '';
	if (!last.includes('.')) return { hexGroups: groups, v4Tail: new Uint8Array(0) };
	const v4Tail = packIpv4(last);
	return v4Tail === null ? null : { hexGroups: groups.slice(0, -1), v4Tail };
}

/**
 * The groups either side of the `::` elision, or null when the literal is malformed.
 *
 * WITHOUT an elision every group is filed under `tail`, right-aligned from byte 0 of a
 * full 8-group address — so the tail is always the half the literal ENDS with, and the
 * only place `splitV4Tail` looks. A triple colon splits into an empty group (`:::1` →
 * `['', ':1']` → groups `''` and `'1'`), which the hex-group check refuses.
 */
function ipv6Halves(value: string): { head: string[]; tail: string[]; elided: boolean } | null {
	if (!value.includes(':')) return null;
	const halves = value.split('::');
	if (halves.length > 2) return null;
	const expand = (half: string): string[] => (half === '' ? [] : half.split(':'));
	if (halves.length === 1) return { head: [], tail: expand(value), elided: false };
	return { head: expand(halves[0] ?? ''), tail: expand(halves[1] ?? ''), elided: true };
}

/**
 * Is this group count legal? Without an elision an address is EXACTLY 8 groups; with
 * one it must be fewer, since `::` stands for at least one zero group — a `::` that
 * elided nothing would be a second spelling of an address that already has one.
 */
function ipv6GroupCountValid(groupCount: number, elided: boolean): boolean {
	return elided ? groupCount <= 7 : groupCount === 8;
}

/** Write one 16-bit hex group at a byte offset. False when it is not a hex group. */
function writeIpv6Group(bytes: Uint8Array, group: string, at: number): boolean {
	// Case-INSENSITIVE: `FE80::1` is the same address as `fe80::1`, and a caller that
	// forgot to lowercase must not get a null (read as "not an address") for it.
	if (!/^[0-9a-f]{1,4}$/i.test(group)) return false;
	const numeric = Number.parseInt(group, 16);
	bytes[at] = (numeric >> 8) & 0xff;
	bytes[at + 1] = numeric & 0xff;
	return true;
}

/**
 * Pack an IPv6 literal into 16 bytes, or null when it is not one. Handles the `::`
 * elision and the embedded-v4 tail (`::ffff:203.0.113.10`, `64:ff9b::192.0.2.1`).
 * Returns null rather than throwing on anything it does not understand — every
 * caller here is a security predicate, so "I could not parse it" must degrade to
 * "no match", never to an exception on the request path.
 */
export function packIpv6(value: string): Uint8Array | null {
	const parsed = splitIpv6(value);
	if (parsed === null) return null;

	const bytes = new Uint8Array(16);
	// The elision fills the gap with zero bytes; `bytes` is already zeroed, so the tail
	// simply starts at its right-aligned offset.
	const tailStart = 16 - parsed.tail.length * 2 - parsed.v4Tail.length;
	if (tailStart < parsed.head.length * 2) return null;
	if (!writeIpv6Groups(bytes, parsed.head, 0)) return null;
	if (!writeIpv6Groups(bytes, parsed.tail, tailStart)) return null;
	bytes.set(parsed.v4Tail, tailStart + parsed.tail.length * 2);
	return bytes;
}

/** Write consecutive hex groups from a byte offset. False on the first non-hex group. */
function writeIpv6Groups(bytes: Uint8Array, groups: string[], start: number): boolean {
	return groups.every((group, index) => writeIpv6Group(bytes, group, start + index * 2));
}

/** Pack an address of either family; the byte length IS the family (4 or 16). */
export function packAddress(value: string): Uint8Array | null {
	return value.includes(':') ? packIpv6(value) : packIpv4(value);
}

/**
 * A CIDR block, packed once. A caller that tests the same blocks on every request (the
 * SSRF guard's range tables) packs them at module load with `packCidr` and asks
 * `packedInBlock`, instead of re-parsing constant text on every address it judges.
 */
export interface PackedCidr {
	readonly network: Uint8Array;
	readonly prefixBits: number;
}

/**
 * A CIDR's packed network address and prefix length, or null when it is not one.
 * Total and fail-closed like everything here: a malformed text is a null, never a throw.
 */
export function packCidr(cidr: string): PackedCidr | null {
	const prefixBits = cidrPrefixBits(cidr);
	if (prefixBits === null) return null;
	const network = packAddress(normalizeAddress(cidr.slice(0, cidr.indexOf('/'))));
	if (network === null) return null;
	// A prefix wider than the family is a typo, not a wildcard. Refusing it is what
	// keeps `/33` from silently meaning `/32`.
	if (prefixBits > network.length * 8) return null;
	return { network, prefixBits };
}

/** A CIDR's prefix length (1-3 digits after the slash), or null. */
function cidrPrefixBits(cidr: string): number | null {
	const slash = cidr.indexOf('/');
	if (slash < 0) return null;
	const prefixText = cidr.slice(slash + 1).trim();
	return /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : null;
}

/** Is a packed address inside a packed block? Never matches across families. */
export function packedInBlock(address: Uint8Array, block: PackedCidr): boolean {
	if (block.network.length !== address.length) return false;
	return sharesPrefix(block.network, address, block.prefixBits);
}

/**
 * The prefix lengths RFC 6052 §2.2 defines for an IPv4-embedded IPv6 address. Any other
 * length has no defined layout, so an address "inside" it carries no IPv4 anyone can
 * name — a translator prefix of another length is a configuration error, not a guess.
 */
export const RFC6052_PREFIX_LENGTHS: ReadonlySet<number> = new Set([32, 40, 48, 56, 64, 96]);

/**
 * The IPv4 address embedded in an IPv6 address under a translator prefix of
 * `prefixBits`, per RFC 6052 §2.2's per-length layout — or null when the address is not
 * IPv6 or the length is not one of the six the RFC defines.
 *
 * The IPv4 starts right after the prefix, EXCEPT that bits 64-71 (byte 8, the "u"
 * octet) are reserved and never carry address bits: a /40 prefix puts three IPv4 octets
 * in bytes 5-7 and the fourth in byte 9, a /56 one octet in byte 7 and three in 9-11.
 * Reading the four bytes straight after the prefix — the obvious shortcut — would put
 * the u octet into the address for every length below /64, and judge a different
 * address from the one the translator reaches. /96 (the well-known `64:ff9b::/96`, and
 * the IPv4-mapped `::ffff:0:0/96`) is simply bytes 12-15.
 */
export function extractRfc6052Ipv4(address: Uint8Array, prefixBits: number): Uint8Array | null {
	if (address.length !== 16 || !RFC6052_PREFIX_LENGTHS.has(prefixBits)) return null;
	const ipv4 = new Uint8Array(4);
	let written = 0;
	for (let at = prefixBits >> 3; written < 4; at++) {
		if (at === 8) continue; // the u octet: reserved, never an address bit
		ipv4[written++] = address[at] ?? 0;
	}
	return ipv4;
}

/**
 * Do two equal-length packed addresses agree on their first `prefixBits` bits?
 *
 * Bitwise, not by string prefix: whole bytes compare directly and the STRADDLING byte
 * is masked to the remaining bits, so `/23` and `/25` mean what they say rather than
 * what a textual comparison would guess.
 */
function sharesPrefix(network: Uint8Array, address: Uint8Array, prefixBits: number): boolean {
	const wholeBytes = prefixBits >> 3;
	for (let index = 0; index < wholeBytes; index++) {
		if (network[index] !== address[index]) return false;
	}
	const remainingBits = prefixBits & 7;
	if (remainingBits === 0) return true;
	const mask = (0xff << (8 - remainingBits)) & 0xff;
	return ((network[wholeBytes] ?? 0) & mask) === ((address[wholeBytes] ?? 0) & mask);
}
