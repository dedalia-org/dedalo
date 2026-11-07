/**
 * The stored URL TEMPLATE of a map source — ONE validator, three callers: the
 * save gate (geo/entry_gate.ts), the import conform (tools/import_conform.ts)
 * and the tile proxy, which re-runs it at FETCH time on whatever it is about to
 * request (a stored template can predate a rule that has since tightened).
 *
 * WHAT A TEMPLATE IS. For `xyz` a URL carrying `{z}`, `{x}` and `{y}` — each at
 * least once, in the path or the query, and nowhere else. For `wms` the plain
 * endpoint with NO placeholder at all: the server builds the GetMap query from
 * the declared params and the request's bbox/width/height (geo/map_source.ts).
 * No other placeholder exists (`{s}`, `{r}`, `{-y}` are refused with the reason
 * "unknown placeholder"): a template language the server does not implement is
 * not a feature, it is a hole.
 *
 * WHAT IT REFUSES, AT SAVE TIME. Not http/https; credentials in the URL; a
 * fragment; whitespace or control characters; a placeholder in the host or the
 * port; an explicit port other than the scheme's own (the tile proxy's door reaches
 * ports 80 and 443 only, so a source on `:8080` could be saved and then never relayed:
 * the validator and the door agree, and `:443` on https is the default and reads as no
 * port at all); a loopback or private ADDRESS LITERAL; a loopback or single-label host
 * name (a name that cannot be public). This is the LITERAL half of the SSRF
 * story, judged by the guard's own predicates (security/ssrf_guard.ts
 * isPrivateIp / isLoopbackHost — the ONE owner of "which address is private"; no
 * range table is copied here). The other half — a public NAME that resolves to
 * an internal address — only exists at connect time and is closed there, by the
 * pinned fetch every outbound door uses.
 *
 * A reason NEVER quotes the URL (see checked.ts).
 */

import { isIP } from 'node:net';
import { isLoopbackHost, isPrivateIp } from '../security/ssrf_guard.ts';
import { type Checked, fail, hasControlChars, pass } from './checked.ts';

export type SourceUrlKind = 'xyz' | 'wms';

/** Longest template accepted — comfortably above any real tile endpoint. */
export const MAX_SOURCE_URL_LENGTH = 2048;

/** The three placeholders an xyz template may carry (and must). */
export const XYZ_PLACEHOLDERS = ['{z}', '{x}', '{y}'] as const;

const ANY_PLACEHOLDER = /\{(?:z|x|y)\}/g;
const HTTP_URL = /^https?:\/\//i;
const AUTHORITY = /^https?:\/\/([^/?#]*)/i;

/**
 * Query keys the SERVER owns on a WMS GetMap request. A stored endpoint that
 * already carries one would make the final query ambiguous (which value wins
 * depends on the upstream), so it is refused; an endpoint's OWN keys (`map=` of
 * a MapServer, an API key) are fine.
 */
const WMS_RESERVED_QUERY_KEYS: ReadonlySet<string> = new Set([
	'service',
	'request',
	'version',
	'layers',
	'styles',
	'format',
	'transparent',
	'crs',
	'srs',
	'bbox',
	'width',
	'height',
	'exceptions',
	'bgcolor',
]);

/** Whitespace anywhere in a URL is a mistake (a pasted line break, a stray space). */
function hasForbiddenChars(text: string): boolean {
	return /\s/.test(text) || hasControlChars(text);
}

/** The URL text, whole: a bounded string with no whitespace and an http(s) scheme. */
function checkUrlText(raw: unknown, where: string): Checked<string> {
	if (typeof raw !== 'string') return fail(`${where}: must be a string`);
	const text = raw.trim();
	if (text === '') return fail(`${where}: must not be empty`);
	if (text.length > MAX_SOURCE_URL_LENGTH) {
		return fail(`${where}: longer than ${MAX_SOURCE_URL_LENGTH} characters`);
	}
	if (hasForbiddenChars(text)) return fail(`${where}: contains whitespace or control characters`);
	if (!HTTP_URL.test(text)) return fail(`${where}: must start with http:// or https://`);
	return pass(text);
}

/** The placeholder rules of `kind` (xyz: exactly z/x/y; wms: none), or a reason. */
function placeholderRefusal(kind: SourceUrlKind, text: string): string | null {
	const leftover = text.replace(ANY_PLACEHOLDER, '');
	if (kind === 'wms') {
		return /[{}]/.test(text) ? 'a wms endpoint takes no placeholder' : null;
	}
	if (/[{}]/.test(leftover)) return 'unknown placeholder (only {z}, {x} and {y} exist)';
	const missing = XYZ_PLACEHOLDERS.filter((placeholder) => !text.includes(placeholder));
	return missing.length > 0 ? `missing placeholder ${missing.join(', ')}` : null;
}

/** A placeholder may stand in the path or the query — never in the authority. */
function authorityRefusal(text: string): string | null {
	const authority = AUTHORITY.exec(text)?.[1] ?? '';
	return /[{}]/.test(authority) ? 'a placeholder cannot stand in the host or the port' : null;
}

/** An address literal: refused when private or loopback. */
function literalRefusal(bare: string, hostname: string): string | null {
	return isPrivateIp(bare) || isLoopbackHost(hostname)
		? 'the host is a private or loopback address'
		: null;
}

/** A host NAME: refused when it names this machine or cannot be a public name. */
function nameRefusal(bare: string, hostname: string): string | null {
	if (isLoopbackHost(hostname)) return 'the host is a loopback name';
	return bare.includes('.') ? null : 'the host must be a public fully-qualified name';
}

/** The host: not a private or loopback literal, not a name that cannot be public. */
function hostRefusal(hostname: string): string | null {
	const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
	return isIP(bare) !== 0 ? literalRefusal(bare, hostname) : nameRefusal(bare, hostname);
}

/** The WMS endpoint's own query must not set a key the server sets. */
function wmsQueryRefusal(url: URL): string | null {
	for (const key of url.searchParams.keys()) {
		if (WMS_RESERVED_QUERY_KEYS.has(key.toLowerCase())) {
			return `the endpoint query sets '${key.toLowerCase()}', which the server sets`;
		}
	}
	return null;
}

/** Scheme and credentials. */
function schemeRefusal(url: URL): string | null {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'must use http or https';
	if (url.username !== '' || url.password !== '') return 'must not carry credentials';
	return null;
}

/** A fragment is never sent to a server, so a stored one is a mistake worth naming. */
function fragmentRefusal(url: URL, text: string): string | null {
	return url.hash !== '' || text.includes('#') ? 'must not carry a fragment' : null;
}

/**
 * Only the scheme's own port. The parsed URL drops a port that IS the scheme's default
 * (`https://host:443/` has `port === ''`), so any port left is a different one.
 */
function portRefusal(url: URL): string | null {
	return url.port === '' ? null : 'must use the standard web port of its scheme (80 or 443)';
}

/** What the parsed URL must satisfy beyond its text: scheme, credentials, fragment, port, host, query. */
function parsedRefusal(kind: SourceUrlKind, url: URL, text: string): string | null {
	const early =
		schemeRefusal(url) ??
		fragmentRefusal(url, text) ??
		portRefusal(url) ??
		hostRefusal(url.hostname);
	if (early !== null) return early;
	return kind === 'wms' ? wmsQueryRefusal(url) : null;
}

/**
 * Validate one stored URL template. The value is returned TRIMMED and otherwise
 * untouched — a template is stored as the editor wrote it, never rewritten.
 */
export function checkSourceUrl(kind: SourceUrlKind, raw: unknown, where: string): Checked<string> {
	const text = checkUrlText(raw, where);
	if (!text.ok) return text;
	const refusal = placeholderRefusal(kind, text.value) ?? authorityRefusal(text.value);
	if (refusal !== null) return fail(`${where}: ${refusal}`);
	let probe: URL;
	try {
		probe = new URL(text.value.replace(ANY_PLACEHOLDER, '0'));
	} catch {
		// A probe catch: the throw IS the verdict ("not a URL"), reported as a reason.
		return fail(`${where}: not a valid URL`);
	}
	const parsed = parsedRefusal(kind, probe, text.value);
	return parsed === null ? text : fail(`${where}: ${parsed}`);
}
