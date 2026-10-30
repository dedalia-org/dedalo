# WC-2026-10-30-sort-data-key-range — a `sort_data` change whose key cannot address a stored item answers `400 request.invalid_data`, never a silent deletion

- **Date:** 2026-10-30 (audit of `applySortData`, `src/core/relations/save.ts`: `target_key` was
  never range-checked).
- **Decision:** DEC-12 (gated: `test/unit/portal_edit_writes_native.test.ts` — the
  `applySortData` key pins, unit, and the dispatch-level twin "sort_data out-of-range / malformed
  key via dispatch", scratch DB, stored data asserted unchanged).
- **Shape before (PHP / TS):** `save` with `changed_data: [{action:'sort_data', source_key,
  target_key, value}]`. Only the item at `source_key` was checked (locator law on
  `section_id, section_tipo, from_component_tipo, tag_id`). A `target_key` the rebuild loop never
  met — `>= items.length`, negative, fractional, `NaN` — skipped the source and never re-inserted
  it: the locator was DROPPED and the save answered `ok:true` with the relation deleted (PHP's
  loop had the identical hole). TS also coerced with `Number()`, so `''`, `null`, `false` read as
  key 0, `true` as 1 and `'2'` as 2 — a malformed payload could pass the locator gate. A locator
  mismatch answered `500 record.save_failed` ("sort_data failed (key/locator mismatch)").
- **Shape after (TS):** both keys must be JSON numbers (`typeof 'number'`, no string/null/boolean
  coercion), integers, inside `[0, items.length - 1]`. Otherwise the save is refused BEFORE the
  move with envelope v2 `{ok:false, request_id, error:{code:'request.invalid_data', …}}`, status
  `400`; nothing is written (the throw rolls the save transaction back). The locator mismatch is
  unchanged on the wire (`500 record.save_failed`; the log line now reads "sort_data failed
  (locator mismatch)"). Valid moves are byte-identical: up lands before the target, down after,
  `source == target` is a no-op, `paginated_key` never persists, stored item first then client
  value (S2-03). Defence in depth: a rebuilt array whose length differs from the stored one is
  refused, so a reorder can never add or drop a locator.
- **Reason:** a reorder that deletes data and answers success is a data-integrity defect, and the
  client can reach it (a page ≥ 2 drag currently adds `paginator.offset` to an already-absolute
  `paginated_key`). Every client door sends JSON numbers (`drag_and_drop.js` `on_drop`, the
  position input in `render_edit_component_portal.js`, `component_portal.sort_data`), so strict
  typing refuses nothing legitimate. A malformed key is a caller fault — `request.invalid_data`,
  the code every malformed `changed_data` change answers (ERRORS_SPEC §8) — and is now
  distinguishable from the stale-drag locator mismatch. The client consumes both through the same
  `ok:false` envelope, so no client change is needed.
- **Gate reconciliation:** no parity gate covers an out-of-range key; the frozen capture
  (`portal_drag_client_capture.json`, replayed by `portal_drag_capture_native.test.ts`) holds only
  valid numeric keys and still replays green. No re-harvest needed (none possible).
