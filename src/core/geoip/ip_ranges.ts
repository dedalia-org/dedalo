/**
 * GEOIP — private / reserved IP classification (pure, dependency-free).
 *
 * The AUTHORITATIVE server-side gate for "this address cannot be geolocated".
 * Returns true for any non-routable / reserved address (IPv4 AND IPv6) plus the
 * sentinels the engine stores for a local request. `resolveCountry` (reader.ts)
 * short-circuits to null on a true here, so no such address ever hits the
 * country database, and the client shows the IP with no flag (never an error).
 *
 * The loopback token set is the dispatcher's `'local'` sentinel plus the loopback
 * addresses ['127.0.0.1','::1','::ffff:127.0.0.1'] — extended here with the full
 * IPv6 private ranges the IPv4-only client filter historically missed (the
 * `::1`/`local` 404 in section Activity that motivated this subsystem).
 *
 * Recognized as private / reserved:
 *   - sentinels: '' , 'local', 'localhost', 'unknown'
 *   - IPv4: 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16, 172.16-31/12,
 *           192.168/16, 255/8, and any malformed dotted quad
 *   - IPv6: :: (unspecified), ::1 (loopback), fe80::/10 (link-local),
 *           fc00::/7 (unique-local), and IPv4-mapped ::ffff:<v4> (unwrapped
 *           and re-tested against the IPv4 rules)
 *
 * Pure and side-effect-free so it is unit-testable without a database or fs.
 */

/**
 * True when `ip` is non-routable / reserved / a local sentinel — i.e. there is
 * no country to resolve and no lookup should be attempted.
 */
export function isPrivateOrReserved(ip: unknown): boolean {
	if (typeof ip !== 'string') {
		return true;
	}

	// Normalize: trim, lowercase, drop an IPv6 zone id ('fe80::1%eth0'), strip
	// surrounding brackets ('[::1]').
	let s = ip.trim().toLowerCase();
	const zone = s.indexOf('%');
	if (zone !== -1) {
		s = s.slice(0, zone);
	}
	if (s.startsWith('[') && s.endsWith(']')) {
		s = s.slice(1, -1);
	}

	if (s === '' || s === 'local' || s === 'localhost' || s === 'unknown') {
		return true;
	}

	// IPv4-mapped IPv6 in dotted form ('::ffff:127.0.0.1') → unwrap and re-test
	// as IPv4. Only the dotted form is unwrapped; the rare hex form falls through
	// to the IPv6 rules below.
	if (s.startsWith('::ffff:') && s.includes('.')) {
		return isPrivateOrReserved(s.slice('::ffff:'.length));
	}

	// IPv6
	if (s.includes(':')) {
		if (s === '::' || s === '::1') {
			return true;
		}
		const firstHextet = s.split(':')[0] ?? '';
		// Unique-local fc00::/7 → high byte fc or fd.
		if (firstHextet.startsWith('fc') || firstHextet.startsWith('fd')) {
			return true;
		}
		// Link-local fe80::/10 → fe8, fe9, fea, feb.
		if (
			firstHextet.length >= 3 &&
			firstHextet.startsWith('fe') &&
			'89ab'.includes(firstHextet.charAt(2))
		) {
			return true;
		}
		return false;
	}

	// IPv4
	const parts = s.split('.');
	if (parts.length !== 4) {
		// Not a well-formed dotted quad (and not an IPv6 handled above) — refuse
		// to geolocate an address we cannot classify.
		return true;
	}
	const octets = parts.map((p) => Number(p));
	if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
		return true;
	}
	const a = octets[0] ?? -1;
	const b = octets[1] ?? -1;
	return (
		a === 0 || // "this network"
		a === 10 || // RFC-1918 class A
		a === 127 || // loopback
		a === 255 || // broadcast / reserved
		(a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
		(a === 169 && b === 254) || // link-local 169.254/16
		(a === 172 && b >= 16 && b <= 31) || // RFC-1918 class B
		(a === 192 && b === 168) // RFC-1918 class C
	);
}
