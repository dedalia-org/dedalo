/**
 * ONE TABLE OF CONFIGURED PUBLIC ORIGINS — `[DEDALO_PROTOCOL, DEDALO_HOST, the ONE origin every
 * sender says, or null]` — shared by every gate that must agree on what the installation is to a
 * third party: the three identity senders and the rule itself (map_tile_geometry_native), the
 * tile route's identity refusal (map_tile_proxy_native) and the geolocation context's
 * `features.tile_direct` (structure_context_geolocation_features). One table, so a sender, the
 * route and the client signal cannot be proved on different values.
 */

/** A well-formed host name (labels under 64) of exactly `length` characters once `https://` is in front of it. */
const originOf = (length: number) =>
	`${'a'.repeat(60)}.${'b'.repeat(length - 'https://'.length - 61 - '.org'.length)}.org`;

/** [DEDALO_PROTOCOL, DEDALO_HOST, the ONE origin every sender says — or null: none says any]. */
export const PUBLIC_ORIGIN_TABLE: readonly [
	protocol: string,
	host: string,
	origin: string | null,
][] = [
	// a public origin, and what URL parsing canonicalizes into the SAME origin
	['https://', 'museum.example.org', 'https://museum.example.org'],
	['http://', 'museum.example.org', 'http://museum.example.org'],
	['https://', 'MUSEUM.Example.ORG', 'https://museum.example.org'],
	['https://', 'museum.example.org:443', 'https://museum.example.org'],
	['https://', 'museum.example.org:8443', 'https://museum.example.org:8443'],
	['https://', 'museum.example.org/', 'https://museum.example.org'],
	['https://', 'museum.example.org.', 'https://museum.example.org.'],
	['HTTPS://', 'museum.example.org', 'https://museum.example.org'],
	['https:', 'museum.example.org', 'https://museum.example.org'],
	['https:/', 'museum.example.org', 'https://museum.example.org'],
	['https://', 'museú.example.org', 'https://xn--muse-tra.example.org'],
	['https://', '93.184.216.34', 'https://93.184.216.34'],
	['https://', '[2001:4860:4860::8888]', 'https://[2001:4860:4860::8888]'],
	['https://', 'localhost.museum.org', 'https://localhost.museum.org'],
	['https://', 'lan.museum.org', 'https://lan.museum.org'],
	['https://', 'arpa.museum.org', 'https://arpa.museum.org'],
	// the bound is on the CANONICAL origin, the one sent: 100 characters is an origin, 101 is not…
	['https://', originOf(100), `https://${originOf(100)}`],
	['https://', originOf(101), null],
	// …and a long configured value that canonicalizes to a short origin is that origin, not cut
	['https://', `museum.example.org:${'0'.repeat(100)}443`, 'https://museum.example.org'],
	// unset, loopback, private and reserved addresses, names no outside resolver answers
	['https://', '', null],
	['https://', 'localhost', null],
	['https://', 'localhost:3500', null],
	['https://', 'dedalo.localhost', null],
	['https://', '127.0.0.1', null],
	['https://', '[::1]', null],
	['https://', '192.168.1.5', null],
	['https://', '10.1.2.3:8443', null],
	['https://', '172.16.0.9', null],
	['https://', '100.64.0.1', null],
	['https://', '169.254.169.254', null],
	['https://', '[fd00::1]', null],
	['https://', '[::ffff:10.0.0.1]', null],
	['https://', '[2001:db8::1]', null],
	['https://', 'intranet-srv01', null],
	['https://', 'museo.local', null],
	['https://', 'museo.local.', null],
	['https://', 'MUSEO.LAN', null],
	['https://', 'museo.home.arpa', null],
	['https://', '1.0.0.10.in-addr.arpa', null],
	['https://', '8.8.8.8.in-addr.arpa', null],
	['https://', 'b.a.9.8.ip6.arpa', null],
	['https://', 'foo.alt', null],
	['https://', 'museo.test', null],
	['https://', 'museo.example', null],
	['https://', 'abcdefghijklmnop.onion', null],
	['https://', 'local', null],
	['https://', `${'a'.repeat(120)}.example.org`, null],
	// a malformed host name: no shared identity disguised as a contact
	['https://', '.museum.org', null],
	['https://', 'foo..org', null],
	['https://', '-.org', null],
	['https://', 'museum-.example.org', null],
	['https://', 'museum.example.org..', null],
	['https://', 'my_host.museum.org', null],
	['https://', `${'a'.repeat(64)}.org`, null],
	// a value that is not a clean origin is NOT repaired: no contact, no Referer, no geo origin
	['https://', 'curator:secret@museum.example.org', null],
	['https://', 'curator@museum.example.org', null],
	['https://', 'museum.example.org/dedalo', null],
	['https://', 'museum.example.org?x=1', null],
	['https://', 'museum.example.org?', null],
	['https://', 'museum.example.org#frag', null],
	['https://', 'museum.example.org#', null],
	// a control character or whitespace URL parsing would silently drop or trim
	['https://', 'museum.example.org\r\nX-Injected: 1', null],
	['https://', 'museum.example.org\nX-Injected: 1', null],
	['https://', 'museum.example.org\u0000', null],
	['https://', 'museum.example.org\t', null],
	['https://', 'museum.example.org ', null],
	['https://', 'muse\tum.example.org', null],
	['https://\r\n', 'museum.example.org', null],
	// not a web scheme
	['ftp://', 'museum.example.org', null],
	['javascript://', 'museum.example.org', null],
	['', 'museum.example.org', null],
	// the ONE scheme check: a special scheme with a tuple origin (`ftp:` parses as a bare
	// origin with a host) is refused by the scheme alone — the header character set judges
	// the host part only, so removing the scheme check turns the ftp row red
	['ftp://', 'museum.example.org:21', null],
	['ws://', 'museum.example.org', null],
	['wss://', 'museum.example.org', null],
	// port 0 is no port: nothing listens there, so nothing is published
	['https://', 'museum.example.org:0', null],
	['https://', 'museum.example.org:000', null],
	['http://', '93.184.216.34:0', null],
	// an UNSET host names nothing: `publicOrigin`'s `localhost` fallback builds update URLs,
	// it is no identity — glued onto a protocol that carries a host it would name
	// `museum.example.orglocalhost`, a host nobody configured
	['https://museum.example.org', '', null],
	['https://museum.example.org/', '', null],
	['http://93.184.216.34', '', null],
	// …and the normal pair beside it is unchanged
	['https://', 'museum.example.org:1', 'https://museum.example.org:1'],
];
