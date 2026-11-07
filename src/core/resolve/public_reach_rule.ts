/**
 * THE PUBLIC-REACH RULE, CONFIG-FREE — the pure half of `public_reach.ts`: given a configured
 * address (`<DEDALO_PROTOCOL><DEDALO_HOST>` as text), which canonical origin, if any, the
 * installation may tell a third party it lives at.
 *
 * Why its own module: two readers ask the SAME question at different times. The engine asks
 * it of the live configuration (`public_reach.ts` `reachablePublicOrigin`, which reads the two
 * keys and calls `identifiableOrigin`); the terminal installer asks it of an ANSWER, before
 * any configuration exists (`install/install_validation.ts` — the installer's plan is
 * config-free: config freezes at import, and the CLI builds the plan before it seeds the
 * environment). One table, one parse, one judgement: an installer that accepted an address
 * the engine then withholds, or refused one the engine would send, would be two rules.
 *
 * The rule itself (what a bare origin is, what "reachable from outside" means) is documented
 * on `public_reach.ts`, the module every sender imports. The loopback and private verdicts
 * are the SSRF guard's own, from its CONFIG-FREE half (`security/address_verdict.ts`): the
 * guard itself reads the declared NAT64 prefixes through src/config/readers.ts, whose import
 * computes install_state.ts's UNCONFIGURED flag — on the installer's closure that froze the
 * run's configuration to its sentinels. So the NAT64 prefixes are a PARAMETER here: the
 * engine (`public_reach.ts`) passes the guard's live ones (`currentNat64Context`), the
 * installer the standardized carriers only (`NO_NAT64`, the default). Gate: the installer's
 * import closure, test/unit/no_install_surface_tripwire.test.ts.
 */

import { isIP } from 'node:net';
import {
	isLoopbackHostIn,
	isPrivateIpIn,
	type Nat64Context,
	NO_NAT64,
} from '../security/address_verdict.ts';

/**
 * Suffixes no outside resolver answers with a web origin: the special-use names (RFC 6761
 * `test`, `example`, `invalid`, `localhost`; RFC 6762 `local`; RFC 7686 `onion`; RFC 9476
 * `alt`), the infrastructure domain `arpa` (reverse DNS `in-addr.arpa` / `ip6.arpa`, RFC 8375
 * `home.arpa`) and the ones networks conventionally keep private. A host equal to a suffix
 * is under it.
 */
const UNREACHABLE_SUFFIXES: readonly string[] = Object.freeze([
	'alt',
	'arpa',
	'corp',
	'example',
	'home',
	'internal',
	'intranet',
	'invalid',
	'lan',
	'local',
	'localdomain',
	'localhost',
	'onion',
	'private',
	'test',
]);

/** The longest CANONICAL origin that joins a header: a longer one is left out, never cut. */
const MAX_ORIGIN_LENGTH = 100;

/**
 * The schemes an origin may have: the ONE scheme enforcement of the rule (`isBareWebOrigin`).
 * `SAFE_HOST` below judges the host part only, so it cannot shadow or stand in for this.
 */
const WEB_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

/** A canonical `URL.host` as it may stand in a header: ASCII host (an IPv6 literal bracketed), port. */
const SAFE_HOST = /^[a-z0-9.:[\]-]+$/;

/**
 * The characters a configured address may hold: printable ASCII but the space, and non-ASCII
 * from U+00A1 (an IDN host). Excluded are exactly the ones URL parsing would silently drop or
 * trim (C0 controls, the space, a tab, CR/LF) and DEL, C1 controls and NBSP.
 */
const CONFIGURED_CHARACTERS = /^[!-~¡-\u{10ffff}]+$/u;

/** One DNS label of a host name: 1–63 letters, digits and hyphens, no hyphen at either end. */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** `hostname` without IPv6 brackets, lower case, one trailing dot (the fully-qualified spelling) dropped. */
function bareHost(hostname: string): string {
	const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	return host.endsWith('.') ? host.slice(0, -1) : host;
}

/** True when `name` is a well-formed host name of at least two labels under no unreachable suffix. */
function isPublicName(name: string): boolean {
	const labels = name.split('.');
	if (labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label))) return false;
	return !UNREACHABLE_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

/** True when an outside machine could resolve and reach `hostname` (a `URL.hostname`). */
export function isReachableFromOutside(hostname: string, nat64: Nat64Context = NO_NAT64): boolean {
	const name = bareHost(hostname);
	if (isLoopbackHostIn(name, nat64)) return false;
	if (isIP(name) !== 0) return !isPrivateIpIn(name, nat64);
	return isPublicName(name);
}

/**
 * True when `url` parsed, is http(s) (`WEB_SCHEMES`, the one scheme check), names a port a
 * connection could use (port 0 is no port: nothing listens there) and is a BARE origin: its
 * serialization is the origin plus `/` exactly, so it carried no credentials, no path, no
 * query and no fragment.
 */
function isBareWebOrigin(url: URL | null): url is URL {
	if (url === null || !WEB_SCHEMES.has(url.protocol)) return false;
	if (url.port === '0') return false;
	return url.href === `${url.origin}/`;
}

/** True when the canonical origin is short enough, and its host part in the conservative character set, to stand in a header. */
function fitsInHeader(url: URL): boolean {
	return url.origin.length <= MAX_ORIGIN_LENGTH && SAFE_HOST.test(url.host);
}

/**
 * `configured` parsed ONCE, when it has the shape of a bare origin that fits in a header:
 * free of control characters and whitespace, http(s), not port 0, no credentials/path/query/fragment, a
 * canonical origin of at most 100 conservative characters. Null otherwise. Reachability is
 * NOT judged here.
 */
function parsedBareOrigin(configured: string): URL | null {
	if (!CONFIGURED_CHARACTERS.test(configured)) return null;
	const url = URL.parse(configured);
	return isBareWebOrigin(url) && fitsInHeader(url) ? url : null;
}

/**
 * True when `configured` (`<protocol><host>`) has the SHAPE of an origin the engine could
 * send — the bare-origin half of the rule, reachability aside. The installer's "is this
 * address well-formed?" (an intranet name is well-formed and unreachable; `https://a b` is
 * neither).
 */
export function isBareOrigin(configured: string): boolean {
	return parsedBareOrigin(configured) !== null;
}

/**
 * THE ONE JUDGEMENT of a configured address: its canonical origin
 * (`https://museum.example.org`) when it is a bare origin an outside machine could reach,
 * else null — exactly what the engine's senders put in a header for that configured value.
 */
export function identifiableOrigin(
	configured: string,
	nat64: Nat64Context = NO_NAT64,
): string | null {
	const url = parsedBareOrigin(configured);
	if (url === null || !isReachableFromOutside(url.hostname, nat64)) return null;
	return url.origin;
}
