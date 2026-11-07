# WC-2026-08-12-authorization-denial-token — a 403 is an ANSWER: `errors:['not_authorized']`, and the refusal carries the environment

- **Date:** 2026-08-12 (engineering/TODO.md "pages where the logged user has not
  access: currently the page shows 'Not retry-able HTTP error 403'. It should
  show a more user-friendly message like 'You don't have permission to access
  this page'").
- **Decision:** DEC-15 (deliberate divergence), DEC-12 (tripwire in the same
  change). Direct sibling of **WC-051**, which fixed the identical defect for 401.

## What the user saw

Opening a section they hold no grant for (a bookmark, a deep link, a shared URL)
produced this, verbatim, over an empty page:

```
Server response msg:
Not retry-able HTTP error 403
 (data_manager catch error)
Home
Received data format is not as expected. See your server log for details
Not retry-able HTTP error 403
 (page build)
```

plus five console errors, one of them `SERVER ERROR. Received data is not JSON
valid or network error`. Nothing there is true: the server understood the request
perfectly, answered in JSON, and the user has nothing to report to anyone.

Three causes, each fixed here:

1. **The token.** `denied(403, 'Insufficient permissions to read')` put the human
   sentence into `errors` — the MACHINE channel — so no client branch could
   match it. Exactly the shape WC-051 removed from 401.
2. **The classification.** The client's fetch layer treated every non-ok status
   except 401 as a transport failure: it threw before `.json()`, so the envelope
   (and its `msg`) never existed as far as the app was concerned, and the retry
   machinery reported a refusal as a network fault.
3. **The language.** `start` is the client's FIRST call. A refusal there left it
   with no `get_label` at all, so even a correct message could only have been
   rendered in the master source language.

## Shape before (PHP, and TS until now)

```
HTTP 403
{ "result": false,
  "msg":    "Insufficient permissions to read",
  "errors": ["Insufficient permissions to read"] }
```

## Shape after (TS)

```
HTTP 403
{ "result": false,
  "msg":    "Insufficient permissions to read",      // humans, logs, tests
  "errors": ["not_authorized"] }                     // the client dispatches on this
```

and, **for the `start` action only**, the same block the success path already
returns rides along:

```
  "environment": { "result": { …page_globals, plain_vars, get_label… } }
```

`notAuthorized()` (`src/core/api/response.ts`) is the single constructor, the
403 sibling of `notLogged()`. All 31 authorization refusals across
`dispatch.ts`, `dd_core_api.ts`, `dd_utils_api.ts`, `dd_external_api.ts`,
`area/read.ts` and `section/read_facade.ts` now go through it, and
`denied(403, …)` is refused mechanically (see the gate).

Its DEFAULT message is generic ("Insufficient permissions") because the message
is shown to the refused user: naming the element they cannot reach would tell
them it exists. Call sites that pass their own sentence keep it — none of them
names a record.

## Why the environment rides the refusal

It is the only way the page can speak the operator's language on the FIRST call,
and it costs nothing the success path was not already paying. It leaks nothing:
the caller is authenticated, the block is theirs, it is byte-identical to what
they receive on any page they CAN open, and it describes the installation, never
the refused element. The refusal itself still carries no `result` — no context,
no data, nothing about what was refused.

## What the user sees now

```
No tienes permiso para acceder a esta página
Home
```

(measured in the browser as a real non-admin session; `lg-eng` renders "You
don't have permission to access this page"). Console errors: zero, beyond the
browser's own "403 (Forbidden)" resource line, which is the truth.

The message is the label `no_access_page` — master + 17 catalogs — rendered by
`render_server_response_error`'s new `not_authorized` case: the sentence, a Home
link, no trace, no "see your server log". The pre-existing component-level
refusal keeps its own label (`no_access`, "No access here"), which is the right
granularity for one widget inside a page the user CAN open.

## Client changes (the byte-identical client is the spec at this seam)

- `data_manager.js` — 403 joins 401's exemption in BOTH fetch layers
  (`handle_errors` and `_fetch_with_retry_and_timeout`), so the envelope reaches
  `.json()` and `api_response_errors` publishes the token.
- `page.js` `build()` — a start answered with `not_authorized` injects the
  environment that rode along, then pushes an api_error of type
  `not_authorized` carrying `get_label.no_access_page`.
- `render_common.js` — the `not_authorized` case.

## Gate reconciliation

`test/unit/authorization_denial_native.test.ts`:

| assertion | why |
|---|---|
| `notAuthorized()` is 403 + `errors:['not_authorized']` + human `msg` | the contract itself |
| the default message names nothing | it is shown to the refused user |
| `denied()` still puts its message in `errors` | the contrast that makes the ratchet meaningful |
| **no `denied(403` anywhere in `src/` or `tools/`** | the ratchet: the token is worthless if the next 403 bypasses it |
| both client fetch layers exempt 403, and the old blanket throw is gone | source-pinned — a fetch refactor silently reinstating it returns the whole defect |
| `page.js` dispatches the token; `render_common.js` has the case; `no_access_page` is defined in master | the three links of the render chain |
| a refused `start` is 403 + token, and CARRIES `environment.result.get_label` | the localization contract |
| the same start for the identity holding the grant is 200 | non-vacuity — without it every refusal assertion passes against a broken engine |

**No re-harvest.** The frozen oracle store holds no permission-refused
interaction (the harvest ran as the superuser), so no fixture response changes.
`test/unit/get_element_context_native.test.ts` and `count_native.test.ts` assert
`body.msg`, which is unchanged.

## Addendum 2026-08-15 — the token becomes the registered code `perm.denied`, and `denied()` is deleted

This entry's contract is preserved and its vocabulary is folded into the closed
taxonomy (`WC-2026-08-15-error-envelope-v2`).

```json
HTTP 403
{ "ok": false, "request_id": "…",
  "error": { "code": "perm.denied", "category": "permission",
             "message": "Insufficient permissions",
             "label_key": "no_access_page", "retryable": false },
  "environment": { "result": { …page_globals, plain_vars, get_label… } },
  "result": false, "msg": "Insufficient permissions", "errors": ["perm.denied"] }
```

- `not_authorized` → `perm.denied` at `error.code`, and (compat window) as the
  single element of `errors`. `label_key` is the pre-existing `no_access_page`
  key this entry introduced — reused, not renamed, because it already says the
  right thing.
- The default message still names nothing: it is shown to the refused user, so
  naming the element would tell them it exists. `perm.*` codes are
  OPERATOR disclosure, so a call site's own sentence no longer reaches the wire
  at all — the finer grain lives in the log line and in `coordinates`.
  `perm.out_of_scope`, `perm.section_not_writable`, `perm.developer_required`
  and `perm.superuser_required` are separate codes for the refusals that ARE
  distinguishable to the client.
- **`denied()` / `notAuthorized()` / `notLogged()` are DELETED** (P1 exit,
  2026-08-15, with the legacy body adapter): every refusal is `throw new
  DedaloError('perm.denied', …)`. `authorization_denial_native.test.ts` pins
  response.ts's export set (no builder, no shell), and
  `error_taxonomy_tripwire.test.ts` refuses any builder call in the tree.
- The `environment` extension key on the refused `start` SURVIVES, and is now
  one of the two NAMED exceptions to "an extension key on a failure is
  exceptional" (the other is the CSRF gate's `action`) — see ERRORS_SPEC §3.0.
  Everything else a failure has to say goes in `error.details`.
- The client-side 403 exemption this entry added to `data_manager` is gone as a
  special case: `api_transport.js` parses the body on ANY status
  (`WC-2026-08-15-error-status-is-a-channel`), so the exemption list that this
  entry and WC-051 each extended by one status no longer exists.

## Addendum 2026-11-07 — the refusal's environment carries `labels_version`, not `get_label` (WC-2026-11-07-labels-separate-resource)

A refused `start` still carries the environment block. The localization contract now comes from `page_globals.labels_version`: `page.js` calls `load_labels` on the `perm.denied` path, and if that fetch fails the panel renders with empty labels instead of breaking the page. The gate `authorization_denial_native` asserts `labels_version`.
