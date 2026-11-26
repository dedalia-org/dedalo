/**
 * DISCOVERY: redirect-only vhosts (spec §3.2 web.vhost — the candidate rule). A vhost that answers
 * every request with a redirect to an absolute URL (the :80 → https:// block, a canonical-host
 * redirect) serves nothing, so it must never receive the APIs include; parse/apache.ts
 * (readVhostBlock) and parse/nginx.ts (findServers) classify their blocks with these shared
 * pieces, each in its own server's grammar.
 *
 * PURE, ZERO-DEPENDENCY (tests/provision_zero_dep.test.ts): no imports.
 */

/**
 * The URL-path regexes that match EVERY request, as operators and certbot write them. A closed
 * list, not a regex analysis: an unlisted pattern is NOT catch-all, so its block stays a candidate
 * (the conservative side — at worst the old behaviour, a choice the operator makes). `^/$` is
 * deliberately absent: it matches only the root.
 */
const CATCH_ALL_PATTERNS: ReadonlySet<string> = new Set([
  '^', '^/', '/', '.*', '^.*', '^.*$', '.*$', '(.*)', '(.*)$', '^(.*)', '^(.*)$',
  '/(.*)', '/(.*)$', '^/(.*)', '^/(.*)$', '/.*', '^/.*', '^/.*$', '^/?(.*)', '^/?(.*)$', '^(/.*)', '^(/.*)$',
]);

export function isCatchAllPattern(pattern: string): boolean {
  return CATCH_ALL_PATTERNS.has(pattern);
}

/** A redirect target that leaves this block: an absolute URL (`https://…`, `http://…`, nginx `$scheme://…`, mod_rewrite `%{REQUEST_SCHEME}://…`). */
export function isAbsoluteRedirectTarget(target: string): boolean {
  return /^(?:https?|\$scheme|%\{REQUEST_SCHEME\}):\/\//i.test(target);
}
