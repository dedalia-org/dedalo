/**
 * ONTOLOGY api_config → a typed, credential-stripped, shape-validated binding.
 *
 * A section BINDS an external service when its ontology node carries
 * `properties.api_config` (zenon1, test3 — plus rsc205, whose copy is a stale
 * duplicate left by a 2024 edit). A binding is NOT externality: whether a
 * section's non-address ids are remote records is `isExternalReferenceSection`
 * (record_fields.ts — the binding AND an owned component_external), the ONE
 * externality predicate; there is deliberately no boolean form of the binding
 * here (2026-09-24 — `isExternalSectionTipo` answered "external" for rsc205's
 * residue and was deleted, not redefined). That property is CATALOGUING DATA:
 * anyone who can edit the ontology can change where the server points.
 * Everything in this module follows from that one fact:
 *
 *  - the ontology proposes, the operator disposes — but at the DOOR, not here.
 *    Parse validates SHAPE only (object, bare entity, parseable http(s) URLs
 *    without embedded credentials, response_map). The operator's host
 *    allowlist (`DEDALO_EXTERNAL_ALLOWED_HOSTS`) is consulted in exactly one
 *    place: transport.ts `fetchExternalJson`, on the final URL, before any DNS.
 *    CLASSIFICATION (is this section external? — record_fields.ts, the TM
 *    restore's section_id transform, section_id.ts) never consults it: egress
 *    policy governs what this server CONTACTS, and a classification contacts
 *    nothing. Checking it here made every TM restore fail `update.refused` on
 *    an install with the default empty allowlist (2026-09-27);
 *  - `ui_base_url` must be http(s), so an edit cannot turn a record link into
 *    `javascript:…` in every user's browser;
 *  - any CREDENTIAL-SHAPED key is STRIPPED before the value is typed, and the
 *    strip is reported. Credentials come from the config readers on a
 *    `scope:'secret'` catalog entry, never from here. Stripping rather than
 *    refusing is deliberate: a legacy install with a key pasted into the
 *    ontology must keep working (minus the key), not fail to boot a section.
 *
 * The resolved binding is cached through `createOntologyCache`, which IS the
 * right lifecycle here — the content is ontology-derived, so an ontology
 * write should drop it. It does NOT depend on the host allowlist (parse never
 * reads it), so an allowlist change needs no invalidation here. (The circuit
 * breaker deliberately does NOT use it; see breaker.ts.)
 */

import { createOntologyCache } from '../core/ontology/cache_factory.ts';
import { getPropertiesByTipo } from '../core/ontology/resolver.ts';
import type {
	ExternalApiConfig,
	PublishedApiConfig,
	ResolvedExternalService,
} from './api/types.ts';
import type { ResponseMap } from './descriptor_types.ts';
import { ExternalServiceError } from './errors.ts';
import { getExternalService } from './registry.ts';

/**
 * Key names that may hold a secret. Matched case-insensitively against every
 * api_config key; a hit is dropped and warned about. Deliberately broad — a
 * false positive costs an unused ontology field, a false negative ships a
 * credential to anyone who can read the ontology.
 */
const CREDENTIAL_SHAPED_KEY =
	/(api[_-]?key|apikey|token|secret|password|passwd|credential|authorization|auth[_-]?header|bearer)/i;

/** Section tipo → its resolved external binding (null = not an external section). */
const resolvedBySection = createOntologyCache<string, ResolvedExternalService | null>();

function badConfig(sectionTipo: string, detail: string, service = 'unknown'): never {
	throw new ExternalServiceError({ service, kind: 'bad_config', sectionTipo, detail });
}

/**
 * Validate one URL field's SHAPE: a non-empty string, parseable, http(s), no
 * embedded credentials. No host allowlist — that is the door's job (header).
 */
function validateUrlField(
	sectionTipo: string,
	service: string,
	field: string,
	value: unknown,
	/**
	 * A URL THIS SERVER fetches (`api_url`, `api_url_search`): it may carry no
	 * query string and no fragment. The adapter builds the query; a key pasted
	 * into the URL (`?apikey=…`) is a credential in cataloguing data that the
	 * key-NAME strip cannot see (T2 S09-c). `ui_base_url` is rendered, not
	 * fetched, and keeps whatever query its catalogue needs.
	 */
	fetched = false,
): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		badConfig(sectionTipo, `api_config.${field} is not a non-empty string`, service);
	}
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		badConfig(sectionTipo, `api_config.${field} is not a URL`, service);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		// This is the `javascript:` case for ui_base_url, and the `file:`/`gopher:`
		// case for an api_url. Refuse loudly — a silently dropped link is a
		// mystery, a refused one is a bug report.
		badConfig(sectionTipo, `api_config.${field} has a non-http(s) scheme`, service);
	}
	if (url.username !== '' || url.password !== '') {
		badConfig(sectionTipo, `api_config.${field} carries embedded credentials`, service);
	}
	// Judged on the RAW text too: `https://host/path?` has an empty `search`.
	if (fetched && (url.search !== '' || url.hash !== '' || /[?#]/.test(value))) {
		// The field is named, the value never is — it may be the credential.
		badConfig(
			sectionTipo,
			`api_config.${field} carries a query string or a fragment — the adapter builds the query; a credential belongs in ../private/.env on a scope:'secret' catalog key`,
			service,
		);
	}
	return url.toString();
}

function parseResponseMap(sectionTipo: string, service: string, raw: unknown): ResponseMap {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw))
		badConfig(sectionTipo, 'api_config.response_map is not an array', service);
	return raw.map((item, index) => {
		if (typeof item !== 'object' || item === null) {
			badConfig(sectionTipo, `api_config.response_map[${index}] is not an object`, service);
		}
		const pair = item as Record<string, unknown>;
		if (typeof pair.local !== 'string' || typeof pair.remote !== 'string') {
			badConfig(
				sectionTipo,
				`api_config.response_map[${index}] needs string local + remote`,
				service,
			);
		}
		return { local: pair.local, remote: pair.remote };
	});
}

/**
 * THE parser. Every api_config in the installation goes through it, and nothing
 * else may build an `ExternalApiConfig` — the constructor IS the validation.
 * Throws `bad_config` only; never returns a partly-vetted object. A host outside
 * the allowlist PARSES — the request to it is refused `blocked_host` at the
 * door (transport.ts), never here.
 */
export function parseApiConfig(raw: unknown, context: { sectionTipo: string }): ExternalApiConfig {
	const { sectionTipo } = context;
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		badConfig(sectionTipo, 'api_config is not an object');
	}
	const source = raw as Record<string, unknown>;

	// Credential strip, FIRST — before anything downstream can read a value.
	const stripped = Object.keys(source).filter((key) => CREDENTIAL_SHAPED_KEY.test(key));
	if (stripped.length > 0) {
		console.warn(
			`[external:unknown] bad_config section=${sectionTipo} credential-shaped api_config key(s) ignored: ${stripped.join(', ')} — secrets belong in ../private/.env on a scope:'secret' catalog key, never in the ontology`,
		);
	}

	const entity = source.entity;
	if (typeof entity !== 'string' || !/^[a-z0-9_]+$/i.test(entity)) {
		badConfig(sectionTipo, 'api_config.entity is missing or not a bare name');
	}
	const service = entity.toLowerCase();

	const apiUrl = validateUrlField(sectionTipo, service, 'api_url', source.api_url, true);
	const apiUrlSearch =
		source.api_url_search === undefined || source.api_url_search === null
			? null
			: validateUrlField(sectionTipo, service, 'api_url_search', source.api_url_search, true);
	// ui_base_url is RENDERED, not fetched: its scheme is what matters (the
	// `javascript:` case). The fetched URLs get the same shape checks; WHERE the
	// server may go is decided at the door.
	const uiBaseUrl =
		source.ui_base_url === undefined || source.ui_base_url === null
			? null
			: validateUrlField(sectionTipo, service, 'ui_base_url', source.ui_base_url);

	return {
		entity: service,
		apiUrl,
		apiUrlSearch,
		uiBaseUrl,
		responseMap: parseResponseMap(sectionTipo, service, source.response_map),
	};
}

/**
 * The ONLY keys an api_config may put on the wire. An ALLOWLIST, not a
 * denylist: the credential regex catches a key called `api_token`, but only an
 * allowlist catches a future `internal_admin_url` or `debug_dump`. Everything
 * unlisted — including rsc205's cataloguer note `info` — is dropped.
 */
const PUBLISHABLE_API_CONFIG_KEYS: readonly string[] = ['entity', 'ui_base_url', 'response_map'];

/**
 * Declared keys that are the SERVER's and stay on it: validated like the rest (a
 * binding with a bad one is not published at all), never put on the wire, and
 * not reported as "dropped" — they are expected. `api_url` / `api_url_search`
 * are fetched by this server through the outbound door; no client code reads
 * them (T2 S09-c, WC-2026-11-19-external-api-url-unpublished).
 */
const SERVER_ONLY_API_CONFIG_KEYS: readonly string[] = ['api_url', 'api_url_search'];

/**
 * THE PUBLICATION SHAPER — the one function that turns a raw ontology
 * `api_config` into something a browser may receive. Both publication paths go
 * through it: the parsed `request_config[].api_config`
 * (core/relations/request_config/external.ts) and the structure-context
 * emitted-properties echo (core/resolve/structure_context.ts).
 *
 * Guarantees, in the order they are enforced:
 *  1. CREDENTIAL-SHAPED keys are stripped (same regex as parseApiConfig);
 *  2. only PUBLISHABLE_API_CONFIG_KEYS survive;
 *  3. every URL is parseable, http(s) and free of embedded credentials.
 *     `ui_base_url` is the one that matters most: the portal concatenates it
 *     with a section_id and hands the result to open_window
 *     (client/dedalo/core/component_portal/js/component_portal.js:2054), so a
 *     `javascript:` value stored in the ontology would be stored XSS on a
 *     curator's click.
 *
 * WHY NO HOST ALLOWLIST HERE (nor in parseApiConfig). `DEDALO_EXTERNAL_ALLOWED_HOSTS`
 * governs what THIS SERVER contacts, and is enforced only at the outbound door
 * (transport.ts). The one URL published (`ui_base_url`) is opened by the CURATOR'S
 * BROWSER — a different trust boundary — and gating them on the server's
 * egress list would silently break a working catalogue link on every install
 * that has not opted into server-side fetching yet.
 *
 * NEVER THROWS. Both call sites are read paths whose job is to render a form;
 * a mis-catalogued api_config must degrade to "no external binding published",
 * loudly logged, not 500 a section read. (Same posture as
 * component_external/value.ts deriveExternalValue.)
 */
export function publishApiConfig(
	raw: unknown,
	context: { sectionTipo: string },
): PublishedApiConfig | null {
	const { sectionTipo } = context;
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		console.warn(
			`[external:unknown] bad_config section=${sectionTipo} api_config is not an object — not published`,
		);
		return null;
	}
	const source = raw as Record<string, unknown>;

	// (1) credential strip, FIRST — before any value is read.
	const credentialKeys = Object.keys(source).filter((key) => CREDENTIAL_SHAPED_KEY.test(key));
	if (credentialKeys.length > 0) {
		console.warn(
			`[external:unknown] bad_config section=${sectionTipo} credential-shaped api_config key(s) not published: ${credentialKeys.join(', ')} — secrets belong in ../private/.env on a scope:'secret' catalog key, never in the ontology`,
		);
	}
	// (2) unknown keys dropped.
	const droppedKeys = Object.keys(source).filter(
		(key) =>
			!credentialKeys.includes(key) &&
			!PUBLISHABLE_API_CONFIG_KEYS.includes(key) &&
			!SERVER_ONLY_API_CONFIG_KEYS.includes(key),
	);
	if (droppedKeys.length > 0) {
		console.warn(
			`[external:unknown] section=${sectionTipo} api_config key(s) not on the publishable allowlist, dropped: ${droppedKeys.join(', ')}`,
		);
	}

	try {
		const entity = source.entity;
		if (typeof entity !== 'string' || !/^[a-z0-9_]+$/i.test(entity)) {
			badConfig(sectionTipo, 'api_config.entity is missing or not a bare name');
		}
		const service = entity.toLowerCase();
		// (3) URL vetting — shape only; see above on why the host allowlist is not
		// this boundary's control.
		// The server-only URLs are VETTED (a binding the server itself would refuse
		// is not half-published) and then left out.
		validateUrlField(sectionTipo, service, 'api_url', source.api_url, true);
		if (source.api_url_search !== undefined && source.api_url_search !== null) {
			validateUrlField(sectionTipo, service, 'api_url_search', source.api_url_search, true);
		}
		const published: PublishedApiConfig = {
			entity: service,
			...(source.ui_base_url === undefined || source.ui_base_url === null
				? {}
				: {
						ui_base_url: validateUrlField(sectionTipo, service, 'ui_base_url', source.ui_base_url),
					}),
			response_map: parseResponseMap(sectionTipo, service, source.response_map),
		};
		return published;
	} catch (error) {
		// A PARTLY vetted binding is a trap (the client would build a link from a
		// half-valid config), so a single bad field refuses the whole object.
		console.warn(
			`[external:unknown] section=${sectionTipo} api_config refused, not published: ${(error as Error).message}`,
		);
		return null;
	}
}

/**
 * The section's external binding, or null when the section is a normal one.
 *
 * An api_config naming an UNREGISTERED service throws
 * `ExternalServiceNotRegisteredError` — it is never quietly reported as "not an
 * external section", which would turn a typo into an empty component.
 */
export async function getExternalServiceForSection(
	sectionTipo: string,
): Promise<ResolvedExternalService | null> {
	const cached = resolvedBySection.get(sectionTipo);
	if (cached !== undefined) return cached;
	const properties = await getPropertiesByTipo(sectionTipo);
	const raw =
		typeof properties === 'object' && properties !== null
			? (properties as Record<string, unknown>).api_config
			: undefined;
	if (raw === undefined || raw === null) {
		resolvedBySection.set(sectionTipo, null);
		return null;
	}
	const apiConfig = parseApiConfig(raw, { sectionTipo });
	const model = getExternalService(apiConfig.entity, { sectionTipo });
	const resolved: ResolvedExternalService = { sectionTipo, model, apiConfig };
	resolvedBySection.set(sectionTipo, resolved);
	return resolved;
}
