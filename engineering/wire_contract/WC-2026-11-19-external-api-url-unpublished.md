# WC-2026-11-19-external-api-url-unpublished — `api_config.api_url` / `api_url_search` are not published; a query string or fragment on either is refused

- **Date:** 2026-11-19 (T2 batch B1, item S09-c; audit finding EXT-1).
- **Decision:** — (DEC-12 gate: `test/unit/external_secret_confinement_tripwire.test.ts`
  §(e) and §(d); behaviour in `test/unit/external_request_config_native.test.ts`;
  parity: `test/parity/request_config_differential.test.ts`).
- Amends `WC-2026-08-05-external-api-config-publication` §2 (the published shape).

## Shape before

- **PHP:** the raw ontology `api_config`, whole, on both publication paths
  (`request_config[].api_config` and the structure-context properties echo). The
  PHP client called the remote service itself, so it needed `api_url_search`.
- **TS until now:** `{ entity, api_url, api_url_search?, ui_base_url?, response_map }`.
  `parseApiConfig` accepted any parseable http(s) URL without embedded
  credentials — a query string included.

## Shape after (TS)

- **Published:** `{ entity, ui_base_url?, response_map }`. `api_url` and
  `api_url_search` are still REQUIRED / vetted (a binding the server would refuse
  is not published at all) and then left out.
- **Parse:** `api_url` / `api_url_search` carrying a query string or a fragment
  (`?…`, `#…`, an empty `?` included) are refused `bad_config`; the message and
  the log line name the field, never the value. `ui_base_url` is unaffected (it
  is rendered, not fetched).

## Reason

- The TS engine calls the service SERVER-SIDE (the outbound door); no client
  code reads either URL (`grep` over `client/` and `tools/`: no reader). They
  told every reader of the section where the server goes.
- A key pasted into the URL (`?apikey=…`) is a credential in cataloguing data
  that the credential strip cannot see — it judges key NAMES. Published, it
  reached every browser that opened the section. The adapter builds the query
  (`src/external/services/*`); a credential belongs on a `scope:'secret'` catalog
  key.
- No vendored ontology value is affected (zenon1, rsc205, test3: no query).

## Gate reconciliation

- `request_config_differential` (external engine item): the fixture side drops
  `api_url` / `api_url_search` before the diff (floored: the frozen answer
  really carries `api_url`). No re-harvest.
- `external_secret_confinement_tripwire` §(e): a query-secret fixture on parse
  (refused, value in no message) and on both publication paths (binding absent,
  value nowhere); §(d) key lists edited deliberately. RED before; mutations red:
  `api_url` republished, parse accepting a query, publish skipping the vetting,
  the raw-text check dropped (empty `?`).
