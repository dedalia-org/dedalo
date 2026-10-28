# WC-2026-10-28-start-component-deep-link-record-scope — a component deep link is record-scope gated

- **Date:** 2026-10-28 (crawl follow-up to WC-2026-10-27-start-deep-link-record-scope).
- **Decision:** DEC-12 (gated: `test/unit/start_record_scope_native.test.ts` "a COMPONENT deep
  link is gated alike", plus "the component data read … never carries the out-of-project value").
- **Shape before (TS):** `start` refused a SECTION deep link to a record outside the caller's
  projects, but a deep link to ONE component of that record (`?tipo=<component>&section_tipo=S&id=N`)
  answered 200: the page shell opened. The component's own data read was already scoped (it
  returns no data for that record), so no value leaked — the door answered "this page exists"
  where the section link answered "refused", and the client mounted an empty component.
- **Shape after (TS):** a deep link whose page is a section OR a `component_*` and whose id is
  >= 1 must name a record `principalCanAccessRecord` allows; otherwise the page refusal
  (403 `perm.denied` + environment), identical for an out-of-scope and a missing record (no
  existence oracle). Areas, tools, id 0 and non-numeric external ids are unchanged.
- **Client:** none. Component deep links the client builds (the image viewer window, …) point at
  the record already open, which is in scope.
- **Gate reconciliation:** TS-only.
