/**
 * The address arithmetic of `src/core/security/ip_address.ts` (`packAddress`,
 * `packCidr`, `packedInBlock`, `sameBytes`) — the SSRF guard's foundation —
 * through two local helpers (`ipInCidr`, `sameAddress`). Moved here from the address-allowlist grammar's gate, retired with its
 * last consumer (the error-report intake, 2026-11-19 —
 * WC-2026-11-19-error-report-email-transport). Pure: no DB, no server.
 */

import { describe, expect, test } from 'bun:test';
import {
	packAddress,
	packCidr,
	packedInBlock,
	sameBytes,
} from '../../src/core/security/ip_address.ts';

/** Is `ip` inside `cidr`, through the live parser (the SSRF guard's path)? */
const ipInCidr = (ip: string, cidr: string): boolean => {
	const address = packAddress(ip);
	const block = packCidr(cidr);
	return address !== null && block !== null && packedInBlock(address, block);
};

/** Same address in any spelling (bytes compared, family included)? */
const sameAddress = (left: string, right: string): boolean => {
	const a = packAddress(left);
	const b = packAddress(right);
	return a !== null && b !== null && sameBytes(a, b);
};

describe('ipInCidr — bitwise, total, fail-closed', () => {
	test('IPv4 in range / out of range, on and off a byte boundary', () => {
		expect(ipInCidr('10.0.0.5', '10.0.0.0/24')).toBe(true);
		expect(ipInCidr('10.0.1.5', '10.0.0.0/24')).toBe(false);
		expect(ipInCidr('10.0.1.5', '10.0.0.0/23')).toBe(true);
		expect(ipInCidr('203.0.113.130', '203.0.113.128/25')).toBe(true);
		expect(ipInCidr('203.0.113.126', '203.0.113.128/25')).toBe(false);
		expect(ipInCidr('10.9.9.9', '10.0.0.0/8')).toBe(true);
		expect(ipInCidr('11.9.9.9', '10.0.0.0/8')).toBe(false);
		expect(ipInCidr('203.0.113.7', '0.0.0.0/0')).toBe(true); // /0 means what it says
	});

	test('IPv6 in range / out of range, in any spelling', () => {
		expect(ipInCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
		expect(ipInCidr('2001:db9::1', '2001:db8::/32')).toBe(false);
		expect(ipInCidr('2001:db8:0:1::1', '2001:db8:0:1::/64')).toBe(true);
		expect(ipInCidr('2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::/32')).toBe(true);
	});

	test('families never match across each other', () => {
		expect(ipInCidr('10.0.0.5', '2001:db8::/32')).toBe(false);
		expect(ipInCidr('2001:db8::1', '10.0.0.0/8')).toBe(false);
		expect(ipInCidr('2001:db8::1', '0.0.0.0/0')).toBe(false);
	});

	test('MALFORMED input denies — and never throws', () => {
		const malformed: [string, string][] = [
			['10.0.0.5', '10.0.0.0'], // no prefix at all
			['10.0.0.5', '10.0.0.0/'],
			['10.0.0.5', '10.0.0.0/abc'],
			['10.0.0.5', '10.0.0.0/-1'],
			['10.0.0.5', '10.0.0.0/33'], // wider than the family
			['10.0.0.5', '10.0.0.0/999'],
			// …and against the address ITSELF: a /33 read as /32 would match here, so
			// only these prove the width refusal (the pairs above miss the network anyway).
			['10.0.0.5', '10.0.0.5/33'],
			['10.0.0.5', '10.0.0.5/999'],
			['2001:db8::1', '2001:db8::1/129'],
			['10.0.0.5', '/24'],
			['10.0.0.5', ''],
			['10.0.0.5', 'not-an-address/24'],
			['10.0.0.5', '10.0.0.0/24/24'],
			['999.0.0.1', '10.0.0.0/8'],
			['10.0.0', '10.0.0.0/8'],
			['10.0.0.5.6', '10.0.0.0/8'],
			['', '10.0.0.0/8'],
			['2001:db8::1', '2001:db8::/129'],
			['2001:db8:::1', '2001:db8::/32'],
			['2001:zzzz::1', '2001:db8::/32'],
			['0x7f.0.0.1', '127.0.0.0/8'],
			// Leading zeros are not a second spelling: `01` is octal to inet_aton and
			// decimal to a naive read, so the literal is REFUSED, not guessed at. Checked
			// against the /32 of the address a decimal read WOULD mean — a case that
			// matched before 2026-09-29 (the old parser read `01` as 1) — so it proves
			// the refusal rather than passing vacuously against a block it misses anyway.
			['127.0.0.01', '127.0.0.1/32'],
			['010.0.0.5', '10.0.0.0/8'],
			['10.0.0.5', '010.0.0.0/8'], // …in the CIDR's network too
		];
		for (const [ip, cidr] of malformed) {
			expect(() => ipInCidr(ip, cidr)).not.toThrow();
			expect(ipInCidr(ip, cidr)).toBe(false);
		}
	});

	test('a MALFORMED dotted tail is not an address, as peer or entry — and never a throw', () => {
		// The module promises PURE and TOTAL: a literal that LOOKS like it ends in a v4
		// tail but does not pack as one must be a null, not an exception in a pre-auth gate.
		for (const bad of ['::ffff:1.2.3', '::1.2.3.256', '1.2.3.4::', '::ffff:1.2.3.4.5']) {
			expect(() => ipInCidr(bad, '0.0.0.0/0'), bad).not.toThrow();
			expect(ipInCidr(bad, '0.0.0.0/0'), bad).toBe(false);
			expect(ipInCidr(bad, '::/0'), bad).toBe(false);
			expect(ipInCidr('1.2.3.4', `${bad}/128`), bad).toBe(false);
			expect(sameAddress(bad, '1.2.3.4'), bad).toBe(false);
			expect(sameAddress(bad, bad), bad).toBe(false);
		}
	});

	test('host-length prefixes (/32, /128) match exactly one address', () => {
		expect(ipInCidr('203.0.113.7', '203.0.113.7/32')).toBe(true);
		expect(ipInCidr('203.0.113.8', '203.0.113.7/32')).toBe(false);
		expect(ipInCidr('203.0.113.6', '203.0.113.7/32')).toBe(false);
		expect(ipInCidr('2001:db8::7', '2001:db8::7/128')).toBe(true);
		expect(ipInCidr('2001:db8::8', '2001:db8::7/128')).toBe(false);
		expect(ipInCidr('2001:db8::6', '2001:db8::7/128')).toBe(false);
	});

	test('the octet boundary: 255 is an address, 256 is not', () => {
		expect(ipInCidr('10.0.0.255', '10.0.0.0/24')).toBe(true);
		expect(ipInCidr('10.0.0.256', '10.0.0.0/8')).toBe(false);
		expect(ipInCidr('255.255.255.255', '255.255.255.255/32')).toBe(true);
		expect(ipInCidr('256.0.0.0', '0.0.0.0/0')).toBe(false);
	});

	test('upper-case IPv6 matches its lower-case CIDR (and the reverse)', () => {
		expect(ipInCidr('2001:DB8::1', '2001:db8::/32')).toBe(true);
		expect(ipInCidr('2001:db8::1', '2001:DB8::/32')).toBe(true);
		expect(ipInCidr('FE80::ABCD', 'fe80::/10')).toBe(true);
		expect(ipInCidr('2001:DB9::1', '2001:db8::/32')).toBe(false);
	});

	test('MALFORMED IPv6 literals deny (RFC 4291 §2.2)', () => {
		for (const ip of [
			'1.2.3.4::', // a dotted quad only as the FINAL 32 bits
			'::1.2.3.4:1',
			'1:2:3:4:5:6:7:8::', // 8 groups AND an elision
			'::1:2:3:4:5:6:7:8',
			'1:2:3:4:5:6:7', // 7 groups, no elision
			'1:2:3:4:5:6:7:8:9',
			'1:::2', // a triple colon
			':::1',
			'1::2::3', // two elisions
			'12345::1', // a 5-hex-digit group
			'1:2:3:4:5:6:7:1.2.3.4', // 7 groups + a v4 tail = 9 groups' worth
			'::ffff:1.2.3.04', // a leading zero inside the v4 tail
			'fe80::1%eth0', // a zone is not part of an address to match
		]) {
			expect(() => ipInCidr(ip, '::/0')).not.toThrow();
			expect(ipInCidr(ip, '::/0'), ip).toBe(false);
		}
		// Positive controls: the well-formed neighbours of the cases above DO match.
		for (const ip of ['::1.2.3.4', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:1.2.3.4', '1::2', 'ffff::1']) {
			expect(ipInCidr(ip, '::/0'), ip).toBe(true);
		}
	});

	test('sameAddress compares BYTES: every spelling of one address, and nothing near it', () => {
		expect(sameAddress('2001:db8:0::1', '2001:db8::1')).toBe(true);
		expect(sameAddress('2001:db8:0::1', '2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(true);
		expect(sameAddress('::ffff:127.0.0.1', '::ffff:7f00:1')).toBe(true); // the hex spelling
		expect(sameAddress('2001:db8:0::1', '2001:db8::2')).toBe(false);
		expect(sameAddress('::ffff:127.0.0.1', '127.0.0.01')).toBe(false); // ambiguous, never guessed
		expect(sameAddress('::1', '0:0:0:0:0:0:0:1')).toBe(true);
		expect(sameAddress('127.0.0.1', '127.0.0.2')).toBe(false); // exact addresses, not a range
		// An IPv4-carrying IPv6 address is a 16-byte value, never the 4-byte IPv4.
		for (const ip of ['::ff00:7f00:1', '::fffe:7f00:1', '::1:ffff:7f00:1', '1::ffff:7f00:1']) {
			expect(sameAddress(ip, '127.0.0.1'), ip).toBe(false);
		}
	});

	test('a 4-byte and a 16-byte address never match, whatever their bytes', () => {
		// `102:304::` starts with the bytes of 1.2.3.4; only the length tells them apart.
		expect(sameAddress('1.2.3.4', '102:304::')).toBe(false);
		expect(sameAddress('102:304::', '1.2.3.4')).toBe(false);
		expect(sameAddress('1.2.3.4', '1.2.3.4')).toBe(true); // positive control
	});
});
