# WC-2026-10-25-tag-id-length-cap — the text_area tag endpoint refuses an `?id=` longer than 4096 characters with `400 request.invalid`

- **Date:** 2026-10-25 (CodeQL #7958 `js/polynomial-redos`, triaged REAL S3: the unauthenticated
  `GET …/core/component_text_area/tag/?id=` ran `/<[^>]*>/g` over the raw id — O(n²) on a run of
  unclosed `<`, ~1.15 s of event-loop CPU per request at 64 KB).
- **Decision:** DEC-12 (gated, mutation-verified: `test/unit/server_codeql_hardening_native.test.ts`
  — the endpoint refusal, the linear strip, and the strip's output equivalence with the regex).
- **Shape before (PHP / TS):** any length was parsed; a hostile id cost quadratic CPU and then
  answered `404 resource.not_found` (unrecognised tag) or a badge.
- **Shape after (TS):** `rawId.length > 4096` (UTF-16 units, after URL-decoding) answers `400`,
  envelope v2 `{ok:false, request_id, error:{code:'request.invalid', message:'Tag id longer than
  4096 characters', …}}`, BEFORE any decode or regex runs. Ids ≤ 4096 are unchanged. The tag strip
  itself is now linear (`stripTags`, `src/core/resolve/html_text.ts`) with byte-identical output, so
  the cap is defence in depth, not the only bound.
- **Reason:** real tag ids (badges, `-data:…:data` draw tags, locator JSON) are well under 1 KB; the
  client never emits a longer one, so no consumer sees the new status. A caller fault is
  `caller`/400 per ERRORS_SPEC §2 — not the fail-closed 404, which means "no such tag/record" and
  would hide an abusive request behind an ordinary miss.
- **Gate reconciliation:** no parity gate covers over-long ids; the frozen fixture store holds no
  such interaction (no re-harvest needed, none possible).
