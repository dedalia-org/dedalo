/**
 * BUILDING THE ADDRESS — the only place a geo service's URL is assembled, and it is
 * assembled from the table, never from the caller.
 *
 * `buildGeoUrl` starts from the origin's `https://host` and the service's fixed
 * path, then sets the query to the service's fixed parameters followed by the
 * caller's CANONICAL parameters (`params.ts`), appended one by one to a
 * `URLSearchParams`. A value can therefore never become a key, a path, a host or a
 * fragment: the encoder percent-encodes `&`, `=`, `#`, `/`, `?`, `@` and every
 * control character, and the caller's own spelling was already replaced by the
 * canonical form.
 *
 * The result is then CHECKED against the table, not trusted: scheme `https`, the
 * origin's exact origin, the service's exact path, no credentials, no fragment. If it
 * is not, the table or this function is wrong, and that is `internal.invariant` —
 * nothing leaves.
 */

import { DedaloError } from '../errors/index.ts';
import { checkParams } from './params.ts';
import { GEO_ORIGINS, type GeoService } from './table.ts';

/** The fixed parameters, then the caller's, in table order. */
function queryOf(service: GeoService, params: unknown, id: string): URLSearchParams {
	const accepted = checkParams(id, service.params, service.refine, params);
	const query = new URLSearchParams();
	for (const [name, value] of service.fixed) query.append(name, value);
	for (const def of service.params) {
		const canonical = accepted.get(def.name);
		if (canonical !== undefined) query.append(def.wire, canonical.wire);
	}
	return query;
}

/** True when `url` is exactly the service's address on its origin. */
function isTheServicesAddress(url: URL, base: string, path: string): boolean {
	const bare = url.username === '' && url.password === '' && url.hash === '';
	return bare && url.protocol === 'https:' && url.origin === base && url.pathname === path;
}

/**
 * The address of one call: the table's origin and path with the service's fixed
 * parameters and the caller's validated ones. Throws `request.invalid_data` for
 * parameters off the service's grammar (see `checkParams`).
 */
export function buildGeoUrl(id: string, service: GeoService, params: unknown): string {
	const { base } = GEO_ORIGINS[service.origin];
	const query = queryOf(service, params, id);
	const url = new URL(base);
	url.pathname = service.path;
	url.search = query.toString();
	if (!isTheServicesAddress(url, base, service.path)) {
		throw new DedaloError('internal.invariant', {
			message: `geo service ${id}: the built address left its table row`,
			coordinates: { service: id },
		});
	}
	return url.toString();
}
