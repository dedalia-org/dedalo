# WC-2026-11-25-publication-host-public-url-http-upgrade — an http public URL is accepted with a notice, and the public-URL probe follows one http → https upgrade

- **Date:** 2026-11-25, with the publication-host install-ease work
  (`engineering/PUBLICATION_HOST_SPEC.md` §2.1, §7; `engineering/OUTBOUND_SPEC.md` §2 *the
  re-call pattern*).
- **Decision:** DEC-12 (each branch gated: the probe's upgrade, its refusals and the
  `httpsUpgradeOf` table by `test/unit/publication_host_probe_native.test.ts`; the origin grammar
  by `test/unit/publication_host_registry_native.test.ts`; the notice and the http acceptance by
  `test/unit/publication_host_widget_native.test.ts`; the field and `public_url_value` by
  `client/dedalo/test/client/js/test_publication_hosts.js`). Amends the `set_host_fields` and
  `probe_public` clauses of WC-2026-10-03-publication-hosts-widget.

## Shape before (PHP)

Nothing: the frozen PHP engine had no publication host. Before this entry (TS):

- `set_host_fields {name, public_url?, …}` accepted an https bare origin only; an `http://`
  `public_url` was `maintenance.action_refused`, and the registry file refused one as a shape
  error (`publication_host.registry_invalid`).
- The probe refused every redirect: a 3xx on either side was the answer (`failed` on the
  published side), and its `detail` did not say where the redirect pointed. An `ok` verdict
  always carried `detail: null`.

## Shape after (TS)

- **`set_host_fields` REQUEST:** `options.public_url` is an http OR https bare origin
  (`registry.ts` `isPublicUrlOrigin`: no path, query, fragment or credentials). http is never
  refused.
- **`set_host_fields` RESPONSE:** when the patch stores an `http://` URL, `msg` gains
  `PUBLIC_URL_HTTP_NOTICE` (*Notice: the public URL is http://. Media is then served
  unencrypted; if the site also answers https, set the public URL to https://… (keep http only
  for an http-only intranet).*). `data` unchanged.
- **Registry file** `<private>/publication_hosts.json`: an `http://` `public_url` is valid.
- **Probe verdict** (`probe_public` `data`, `apply_rules`'s `probe` key, `get_value` rows'
  `public_probe`, and `<private>/publication_hosts_runtime.json` `runtime.probe`):
  - `detail` may be NON-NULL with `state: 'ok'`: when one side followed the http → https
    upgrade, `http redirects to https — set the public URL to https://<host>` (kept when the
    copy-host check turns a 404 into `unknown`).
  - a refused redirect's `detail` appends `: redirected to <target>, not followed (only one http
    → https upgrade of the same host, path and query is)` — credentials stripped from the
    target, capped at 200 characters.
  - The statuses are the https answer's when the upgrade was followed.
- **`probe_public` RESPONSE `msg`:** an `ok` verdict with a detail appends the detail to the OK
  sentence (`probeSentence`).
- **Client:** the public URL field shows an `https://` placeholder and proposes `https://` on
  focus (cleared on blur if left bare); `public_url_value` prefixes `https://` to a scheme-less
  value and keeps an explicit `http://`; after a save the panel shows the server's `msg`, notice
  included, instead of the raw `data`.
- **Internal, not wire:** a refused redirect is a `RedirectRefused` (`security.outbound_failed`,
  coordinates `{reason: 'redirect', status}` only); the raw `Location` is a separate, never-logged
  field read with `refusedRedirectLocation`.

No new action, no new error code.

## Reason

Many institutions configure the site as `http://…` and let the web server move visitors to
https; a probe that called that redirect a failure reported a broken gate on a working site. An
intranet site served only over http is legitimate and must be checkable, so it is accepted and
named rather than refused. Following exactly one upgrade — built from the probe's own URL and
re-vetted through the same door — keeps the probe a stranger's view without opening a redirect
path: a redirect to another host, a downgrade or a chain is still the answer, now with its target
named so the operator can fix the URL.

## Gate reconciliation

No parity gate covers the publication-host channel (TS-only); no fixture changes, no re-harvest.
