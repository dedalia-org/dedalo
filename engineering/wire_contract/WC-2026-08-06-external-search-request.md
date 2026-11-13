# WC-2026-08-06-external-search-request — external search moves from the browser into the engine

- **Date:** 2026-08-06 (the last gap of the external-record subsystem;
  engineering/EXTERNAL_SPEC.md §10 was "DECLARED, UNIMPLEMENTED" until today).
- **Decision:** — (DEC-12 gates shipped with it:
  `test/unit/external_search_native.test.ts`, the `query_terms` half of
  `test/unit/external_egress_tripwire.test.ts` and the new
  `test/unit/external_search_target_tripwire.test.ts` — all registered in
  `engineering/TRIPWIRES.md` + `scripts/verify.ts`).
- **Re-harvest: NO — impossible by definition.** The oracle is frozen; this
  entry records a deliberate contract edit.

### Shape before

`client/dedalo/core/services/service_autocomplete/js/service_autocomplete.js`
(`zenon_engine`, ~:857-1110) issued the search itself, as a cross-origin
`XMLHttpRequest` from the CURATOR'S BROWSER:

```
POST https://zenon.dainst.org/api/v1/search
     ?lookfor=<q>&type=AllFields&sort=relevance&limit=20&prettyPrint=false&lng=de
     &field[]=<f>…
```

with the URL taken from the published `api_config.api_url_search` (falling back
to a hard-coded literal), `limit` frozen at `20`, `lng` frozen at `de`, and an
empty query replaced by the sentinel string `ñññññññ---!!!!!` — because Zenon
answers an empty `lookfor` with its first ten records. The answer was then
reshaped in the browser by `format_data` into a fabricated server response.

Being browser-direct, it went round EVERY control the subsystem has
(EXTERNAL_SPEC §5): the master and per-service kill switches, the operator's
host allowlist, `assertPublicUrl` + the socket pin, the circuit breaker, the
concurrency ceiling, the streamed byte cap, the retry policy and the egress
classification. None of them can see a request the server never makes. It also
could never work for an authenticated service — a credential that reaches a
browser is a published credential.

Since the XSS-02/RC-01 hardening (2026-07-28) it did not work at all: the app's
own CSP names no third-party origin in `connect-src`, so the browser refused the
call and the XHR surfaced a bare "There was a network error". **The fix is not
to re-open `connect-src`** — that directive would then have to name a host read
out of an OPERATOR-EDITABLE ontology field, i.e. a cataloguer could aim the
browser's connect policy at any host.

### Shape after

The browser asks the engine (`dd_external_api::search`, authenticated +
CSRF-gated), the engine asks the service through the ONE outbound door
(`src/external/transport.ts`), which puts the request behind the host allowlist,
`assertPublicUrl` + socket pinning, the credential-after-vetting order, the
breaker, the concurrency ceiling, the byte cap and the retry policy.

The wire form the ENGINE now sends, which is byte-identical to the browser's on
the default page:

```
POST <api_url_search>?lookfor=<q>&type=AllFields&sort=relevance
     &limit=<n>[&page=<p>]&prettyPrint=false&lng=<alpha2>[&field[]=<f>…]
```

Four deliberate divergences, each gated:

1. **`lng` is derived from the request's data lang**, through the same
   `getAlpha2FromCode` helper and the same `en` fallback the record path uses
   (`lgn`). The browser sent the literal `de` for every user in every
   installation, so a Spanish or English cataloguer was reading German labels.
2. **The empty-query sentinel is REMOVED, not ported.** An empty (or
   whitespace-only) query is refused in the engine BEFORE any socket and answers
   an empty result; the adapter refuses it again. A magic string whose
   correctness depends on a remote tokeniser continuing to fail to match it is
   not a contract — the day Zenon indexes it, the sentinel starts returning
   records. `external_search_native` asserts the literal is absent from the
   engine and that zero fetches happen on an empty query.
3. **`limit` and `offset` come from the caller**, defaulting to `limit: 20`
   (the old literal). `offset` is expressed as VuFind's 1-based `page`; page one
   omits the parameter entirely, which is what keeps the default byte form
   identical. An offset that is not a whole number of pages is **REFUSED**, not
   rounded — VuFind cannot express it, and answering the neighbouring window is
   a wrong answer that looks right. A limit above `MAX_SEARCH_LIMIT` (100) is
   refused rather than clamped, because a clamped page is indistinguishable from
   "the service has no more".
4. **The values are emitted by the engine's ONE emission function**
   (`mapRowToEntries`), so a search cell obeys the same declared `format`s, the
   same per-entry length/count ceilings and the same refusal counting as a
   record read. The browser had its own ad-hoc formatter (author roles joined
   with `' - '`, arrays with `', '`) that agreed with nothing else in the
   engine; the normalisation rules are those of
   `WC-2026-08-05-external-entry-normalisation`.

**Egress.** `zenon` now declares TWO classes: `egress: 'record_identifiers'` for
the record path and `searchEgress: 'query_terms'` for the search path. One field
could not be honest about both — a search sends free text a cataloguer typed,
which is strictly heavier than a set of ids. `external_egress_tripwire` holds
each path to its own class, and proves a record request *cannot* carry terms:
`ExternalRecordRequestContext` has nowhere to put one.

**Caching.** Search results are NOT cached (records still are). A query is
free text, one per keystroke — an unbounded key space with a near-zero hit rate
— and a stale RESULT SET is a wrong answer to "what is in the catalogue?" with
nothing to mark it, unlike a stale ROW which carries a `stale` marker.
Identical **in-flight** queries are still coalesced. Reasons stated in the
`src/external/search.ts` header; both halves gated.

### Client-visible payload

The action returns the shape the client's `format_data` fabricated, so the
rendering path downstream is untouched:

```json
{ "result": { "context": [ <the show ddo_map> ],
              "data": [
                { "section_tipo": "zenon1", "tipo": "<caller tipo>",
                  "typo": "sections",
                  "entries": [ { "section_tipo": "zenon1", "section_id": "001338683" } ] },
                { "section_tipo": "zenon1", "section_id": "001338683",
                  "type": "dd687", "tipo": "zenon4", "mode": "list",
                  "entries": [ "Coinage of the Roman provinces" ] }
              ] },
  "msg": "OK. Request done",
  "total": 137, "limit": 20, "offset": 0 }
```

`section_id` is the remote id in STORAGE form — the zero-padded string, never a
number. `total`/`limit`/`offset` are ADDED keys (the browser engine could not
report a total at all); the client ignores unknown keys, so the envelope widens
without changing.

**What the client may NOT send:** a URL, a host, a service name, a field list —
or a render mode. The request carries only the caller component's `tipo` +
`section_tipo`, the terms and a page; the target section is DERIVED (below), the
service comes from that section's `api_config`, and the field list from each
external node's own `properties.fields_map`. A client that could name any of
those would be the browser-direct call again, wearing the engine's socket.

### How the target section is DERIVED (corrected 2026-08-06, same day)

Because the client names nothing, the derivation is load-bearing, and the first
cut got it wrong two ways — both found by resolving this installation's six real
`api_engine` callers rather than by reading the code:

1. **The target is the section of the ddos that ARE external** (predicate: the
   descriptor facet `emitHook: 'external'`), never `ddo_map[0]`'s section.
   `relations/request_config/external.ts` does use the first ddo — correctly,
   as PHP parity on a PUBLICATION path — but a PORTAL's external item leads with
   its own portal ddo (`rsc1285` → `rsc368`@`rsc332`) and lists the `zenon1`
   fields after it. Under the first-ddo rule `rsc1285`, `tchi29` and
   `numisdata162` resolved to a section with no `api_config` and answered every
   search `misconfigured`. The browser engine had hidden exactly this behind its
   hard-coded fallback URL — which is why nobody had seen it.
2. **Every render mode is asked.** The builder answers a different item set per
   mode (a `section_list` child substitutes the whole config in list-like
   modes), so `numisdata162` declares its external item in EDIT only and a
   `list`-only lookup resolved nothing at all. The client may not name the mode:
   that is config travelling from the browser.
3. **Ambiguity is REFUSED, both sections named** — never resolved by taking the
   first. Two external targets mean two services, the client cannot say which
   source selector it is on (by design), and searching the wrong catalogue is a
   wrong answer that looks right.

Gate: `test/unit/external_search_target_tripwire.test.ts` (credless, against
frozen copies of what the builder really answers for those nodes, plus an
ontology half that runs the real resolver wherever the DB carries the tree).

### The client half (landed the same day)

`service_autocomplete.js`'s `zenon_engine` is now `external_engine`: it calls
`dd_external_api::search` through `data_manager.request` — the client's ONE
request path, which carries the session cookie, the CSRF token and its rotation,
the 401 re-login recovery and the error reporting — and `zenon_engine` remains
as a stable alias, because `autocomplete_search` resolves an engine by NAME
(`api_engine + '_engine'`) and an ontology may carry `api_engine: 'zenon'`.
Any OTHER non-`dedalo` `api_engine` now resolves to `external_engine` too: the
browser no longer needs to know which service it is talking to, so a second
service is an ontology edit, not a client edit.

Deleted from the browser, because the engine owns them: the hard-coded
`https://zenon.dainst.org/api/v1/search` fallback, `lng:"de"`, the
`ñññññññ---!!!!!` sentinel, the `field[]` list, the `case 'authors'` formatter
and the whole `format_data` fabrication. What the browser still decides is
presentational only. Gate: the fourth section of
`test/unit/external_client_render_tripwire.test.ts` — no absolute URL, no
`XMLHttpRequest`/`fetch`/`WebSocket`/`sendBeacon`, none of the retired literals
(comments included), and the request may not name a url, a host, a service or a
field list. Behaviour half: `client/dedalo/test/client/js/test_service_autocomplete.js`.

**The empty query never leaves the browser.** The engine answers it with an
empty result and no socket, so asking is pure latency; `external_engine`
short-circuits and returns a local `source_status` of state `empty_query`.

### Failure states on the wire (client-visible)

A search that fails does NOT return 4xx: `data_manager.request` reads a non-ok
response as a thrown fetch error (only 401 is let through, WC-051), so a 4xx
body — everything the server said about WHY — is discarded before any caller
sees it. So a SERVICE or CONFIGURATION failure answers HTTP 200 with:

```json
{ "result": false,
  "msg": "Error. The external search did not complete",
  "errors": ["external_blocked_host"],
  "source_status": { "service": "zenon", "state": "misconfigured",
                     "label_key": "external_source_misconfigured",
                     "retryable": false } }
```

`source_status` is the SAME object the record path emits (component_external),
built by the same `stateForKind` + `externalSourceStatus` pair — one taxonomy,
one state→label_key map. The client renders it through the same
`source_status_label` helper, so a state never gets two different words, and the
text is always a labels-catalog KEY (`src/core/labels/master.json`), never
prose. `errors` keeps the finer grain the closed state set folds away
(`blocked_host` and `not_registered` are both `misconfigured`) as operator
diagnostics in the notice's `title`.

A 4xx is now reserved for CALLER FAULTS (missing `source.tipo`, an unparseable
page, no read permission) — a programming error nobody translates.

Two new label keys: `external_search_empty_query` (nothing was typed — the one
NEUTRAL state, and it must not look like a failure) and `external_search_failed`
(the response failed with no envelope at all: a 4xx, or a thrown fetch).

## Addendum 2026-08-15 — the status rule of this entry is SUPERSEDED

Everything above about the REQUEST — the derivation of the target section, the
egress classes, the removed sentinel, the caching decision, the client half —
stands. Two statements about the FAILURE shape do not:

1. **"A search that fails does NOT return 4xx… so a SERVICE or CONFIGURATION
   failure answers HTTP 200 with `result:false`."** Superseded by
   `WC-2026-08-15-external-degradation-is-a-notice`: a degraded source answers
   `ok:true` + one coded notice (`external.<kind>`, `details.service`), with the
   `source_status` object kept as an extension key for the chip during the
   compat window. Degradation is not a failure of the request.
2. **"A 4xx is now reserved for CALLER FAULTS."** Superseded by
   `WC-2026-08-15-error-status-is-a-channel`: the HTTP status is derived from
   the error code's category for EVERY failure — `caller` 400, `auth` 401,
   `permission` 403, `not_found` 404, `conflict` 409, `limit` 429,
   `unavailable` 503, `internal` 500 — and `ok:false ⇒ status ∉ 2xx`.

The reason this entry gave for both rules was a CLIENT defect, stated plainly
here at the time: `data_manager.request` read a non-ok response as a thrown
fetch error and discarded the body before any caller saw it. That defect is
fixed rather than accommodated — `api_transport.js` parses the body on any
status — so the per-status exemption list (401 from WC-051, 403 from
WC-2026-08-12) is gone with it.

The two label keys this entry introduced survive: `external_search_empty_query`
(the one NEUTRAL state) and `external_search_failed`, now reachable as the
`label_key` of the corresponding registry rows.

## Addendum 2026-09-24 — a refused remote field name is one column's error, not the search's

Cross-reference: `WC-2026-09-24-external-record-field-set` addendum (b), the
record-path twin of this change.

### Shape before (TS)

`hydrateExternalSearchDdos` unioned every external ddo's `fields_map` names into
the `field[]` list with no adapter filter. One name Zenon refuses (not a bare
identifier: `dc:title`, `publication-dates`) made `buildSearchRequest` throw
`bad_config` before any socket, and the action answered the degradation
envelope: `ok:true`, `data: { context: [], data: [] }`, one `external.bad_config`
notice, `source_status.state: 'misconfigured'` — the whole search box blank for
one column's typo.

### Shape after (TS)

- The binding is resolved BEFORE hydration; its adapter's `acceptsRemoteField`
  filters the union (`reportRefusedRemoteFields`, record_fields.ts — the record
  path's own report). A refused name never reaches `field[]`; the accepted
  names keep declaration order, so a config with no refused name sends the
  same bytes as before.
- The ddo that maps it keeps its place in `context` and in each hit's rows
  (index pairing), and every row of it is
  `{ …, entries: [], source_status: { state: 'misconfigured', … } }` —
  the record path's misconfigured value. Every other column renders from the
  live answer. One `external.bad_config` log line names the tipo and the
  name(s), deduped by the log door (the same line the record path logs).
- Only when EVERY hydrated ddo maps a refused name is the search refused
  (`external.bad_config`, "no external field the <service> service accepts") —
  the existing degradation envelope.

### Gate reconciliation

No parity fixture holds an external search; no re-harvest. Behaviour:
`test/unit/external_search_action_native.test.ts` ("a remote field name the
adapter refuses") and `test/unit/external_search_native.test.ts` ("one refused
remote field name does not blank the search", the built `zzxt` situation,
resolved end to end with a stub transport), mutation-verified — dropping the
union filter, the misconfigured row, the all-refused refusal or the log each
reddens a case.

## Addendum 2026-09-27 — allowlist refusal moved to the door

A search against a non-allowlisted host now parses and is refused
`blocked_host` by `fetchExternalJson` before any DNS, with the real service
named in the notice. See `WC-2026-09-27-external-allowlist-at-door-only`.

## Addendum 2026-11-13 — item 4 amended: a search cell renders author NAMES (owner C55)

Item 4 ("the values are emitted by the engine's ONE emission function") stands:
`formatExternalSearchData` still calls `mapRowToEntries` with the node's
fields_map and the same ceilings and refusal counting. What changes is WHICH
format a search cell applies. The owner ruled (T1-P06 §7, option B) that the
dropdown must not show the API's untranslated role keys: an adapter may declare
`searchFormats` (`ExternalServiceModel`, descriptor_types.ts) — record format
name → the format a SEARCH cell applies instead — and the handler substitutes
it (`searchFieldsMap`). Zenon declares `zenon_authors → zenon_author_names`:
the names of every non-empty role joined `' - '`, no role labels, the v6
browser's byte form (`Ripollès Alegre, P. P. (Pere Pau)`;
`Doe, J. - Roe, R. - DAI`), with `zenon_authors`' own empty and refusal rules.
The RECORD path keeps `zenon_authors` (`primary: …`) — `WC-2026-08-05` and
`WC-2026-11-13-external-empty-entry-dropped` are untouched. Both names must be
declared formats (`external_registry_totality_tripwire`). Gates:
`external_search_native.test.ts` ("values come from the ONE emission function…
authors as NAMES ONLY", the PARTIAL situation's authors column),
`external_zenon_native.test.ts` (`zenon_author_names`; the record path pinned).
Docs: `docs/core/components/component_external.md`,
`docs/core/system/external_services.md`. Fragment `external-search-author-names`.

