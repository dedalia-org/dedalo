# WC-017 — `dd_error_report_api:receive_report`, a TS-only pre-auth intake action (PHP has no twin)

- **Date:** 2026-07-10 (user-approved error-report feature).
- **Shape:** a NEW API class+action with no PHP counterpart — the TS
  ACTION_REGISTRY was previously action-complete vs PHP API_ACTIONS, so any
  TS-only action is ledgered here. `receive_report` accepts an error report
  relayed machine-to-machine by another installation's server (the
  tool_error_report relay, WC-019) and appends it to the TS-owned
  `dedalo_ts_error_reports` table (migration 0002).
- **Exposure:** pre-auth (`NO_LOGIN_ACTIONS` + `CSRF_EXEMPT_ACTIONS`, the
  login posture) but FLAG-GATED: dispatch Gate 1c refuses unless
  `DEDALO_ERROR_REPORT_RECEIVER=true` (default off), answering the EXACT
  Gate-1 unregistered-action shape so a probe cannot learn the endpoint
  exists. Hardening in the handler: per-(entity,ip) sliding-window throttle,
  optional per-deployment shared token (constant-time), 256 KiB payload
  clamp, strict shared Zod schema. Security posture + privacy/retention:
  SECURITY_DECISIONS.md "Error-report intake".
- **Coexistence risk:** none — PHP never dispatches the class; a PHP server
  receiving the RQO answers its own unknown-action error, which the relay
  reports honestly to the admin.
- **Gate reconciliation:** no differential covers unknown API classes (no red
  to normalize). TS ground truth pinned in
  `test/unit/error_report_receiver.test.ts` (flag off/token/throttle/schema/
  stamping paths).

## Addendum 2026-08-15 — the Gate-1c mimicry becomes a CODE identity

The intake's exposure posture is unchanged. What changes is HOW the "a probe
cannot learn the endpoint exists" property is expressed
(`WC-2026-08-15-error-envelope-v2`, `WC-2026-08-15-install-refusals-typed`):

- A disabled Gate 1c and an unregistered action now throw the SAME
  `DedaloError`, from the same `unknownAction()` constructor in
  `src/core/api/dispatch.ts`: `request.unknown_action` (400) with
  `details.action`. The two bodies are byte-identical minus `request_id`, and
  they stay identical because there is one constructor, not two hand-built
  bodies that drift the moment either is edited — which is the whole value of
  the mimicry.
- The IP refusal is `install.ip_denied` (403); a request that gets past the gate
  and fails the handler's own hardening throws its own registered code, so a
  throttle rejection is no longer indistinguishable from a schema rejection.
- A relaying installation that reaches an engine where the receiver is off now
  gets `error.code = "request.unknown_action"` rather than prose, which is what
  the relay (WC-019) reports to its admin.
- Gate: `error_report_receiver.test.ts` (unchanged in substance) plus
  `dispatch_error_native.test.ts`, which pins the two bodies EQUAL.

## Addendum 2026-10-12 — superseded by WC-2026-10-12-install-surface-removed (the sentence naming `install.ip_denied` as the intake's IP refusal: the dispatcher throws `perm.denied` ("Error report not permitted from this address"), and the install code is deleted)

## Addendum 2026-11-19 — email transport

RETIRED. The action, its Gate 1c and every pre-auth row are deleted; reports travel by email from the sending installation. See WC-2026-11-19-error-report-email-transport.
