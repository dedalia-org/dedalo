# WC-2026-08-05-external-entry-normalisation — external entries are always sanitised strings, bounded and reported

- **Date:** 2026-08-05 (with WC-2026-08-05-external-derived-emission).
- **Decision:** — (DEC-12 gates: `test/unit/external_fields_map_native.test.ts`,
  `test/unit/external_degradation_tripwire.test.ts`).

### Shape before (PHP)

`component_external::get_dato()` folded `fields_map` over the decoded payload
with `array_reduce` and handed the result to the client **as the service sent
it**:

- with no `format` declared, whatever type came back went on the wire — arrays
  and objects included (the client then rendered `[object Object]`, or an
  `Array` join, depending on the view);
- there was no length or count bound at all, so a service answering a 400-field
  record, or one 2 MB abstract, put all of it in the response;
- markup was passed through untouched. The v7 client's own comment
  (`view_default_edit_component_external.js`) says the SERVER sanitises it.
  Nothing did;
- with several `local:'dato'` rows in one `fields_map`, `array_reduce` meant
  the LAST resolvable row silently won and the others vanished;
- a multi-row answer was reduced blindly, so a response that did not contain
  the requested record still yielded "whatever came first".

### Shape after (TS)

`entries` is `string[]`, always, produced by `src/external/fields_map.ts`:

- **Every value is a STRING.** A `format` named in `fields_map` must be one the
  adapter implements, or the mapping is refused as `bad_config` (a cataloguing
  error must be visible, not rendered). With no `format`: string/number/boolean
  coerce, an array fans out into several entries, and an OBJECT is REFUSED and
  counted as `dropped_unrenderable` — writing `[object Object]` into a heritage
  record is worse than a reported gap.
- **A FORMAT REFUSES OBJECTS TOO** (2026-08-06). The rule above is the emission's
  rule, not the unformatted path's rule: a formatter returns its refusal count on
  `FormattedValue.refused`, which joins the same `dropped_unrenderable` counter,
  and a value whose every item was refused contributes NO entry (an empty string
  would read as "the service holds an empty value", a different and false
  statement). `zenon`'s `array_values` is the first: it drops object items
  instead of `String()`-ing them. Before this, `{local:'dato', remote:'authors',
  format:'array_values'}` — one wrong word in a fields_map — emitted
  `"[object Object]"` with `degraded:false` and no `source_status` at all, i.e.
  the one outcome the bullet above exists to prevent.
- **`array_values` DROPS empty elements — a deliberate byte divergence.** PHP
  `implode(' | ', ['213 p.', ''])` keeps them and emits `"213 p. | "`; the TS
  filters `null`/`undefined`/`''` first and emits `"213 p."`. Kept because a
  dangling separator is a rendering artifact rather than data — no value is lost
  either way — and because the emission is a bounded, reported list where an
  empty entry is meaningful elsewhere. Recorded (not silently inherited) so the
  next reader knows the difference is a decision. Pinned in
  `external_zenon_native.test.ts`.
- **Two kinds:** `text` and `markup`. A `markup` value is server-sanitised by a
  strict allowlist RE-EMITTER (not a stripper): text is escaped, `b i em strong
  sub sup br p ul ol li` are re-emitted BARE — no attributes survive, not even
  `class`, so there is no `href`/`src`/`style`/`on*` surface — and everything
  else disappears while its text is kept. `script/style/iframe/object/embed/svg/math`
  elements are removed with their content. This makes the client's existing
  claim true.
- **Two ceilings, both REPORTED** (never silent): a value longer than
  `maxEntryChars` is **REFUSED**, not cut (`dropped_over_length`) — a silently
  shortened title is a wrong title that looks like a real one; entries beyond
  `maxEntries` are cut (`dropped_over_count`). Both surface in `source_status`
  (see WC-2026-08-05-external-source-status).
- **Every resolvable `local:'dato'` row contributes, in declaration order** —
  the deliberate divergence from `array_reduce`'s last-one-wins. Both engines
  agree on every node in this installation (each `component_external` declares
  exactly one `dato` row), so no live output changes; the divergence is
  recorded because a future two-row map would differ.
- **The requested record, or nothing.** Ledgered on its own, in
  WC-2026-08-05-external-first-record-reduce — the blind `array_reduce` row pick
  is replaced by an id-matching `defaultPickRow`.

### Reason

The wire type of a component's value cannot depend on what a third party
happened to send. The client renders `entries` as strings; anything else is a
rendering bug at best and injected markup at worst. The ceilings exist because
a remote answer is unbounded input into a page the institution serves — and
they are reported because an invisible cut is data loss that nobody
investigates.

### Gate reconciliation

`external_fields_map_native` pins the extractor, both Zenon formats, the
object-refusal, the sanitiser (including the raw-content elements and the
attribute strip) and both ceilings. `external_degradation_tripwire` pins that
the drops reach the wire as `source_status` counters rather than vanishing.

**No parity fixture is affected**: no fixture in the frozen oracle-harvest
store holds a data item for any `component_external` tipo. **Re-harvest: NO —
impossible by definition.**

### Addendum 2026-11-13

The "contributes NO entry" rule now covers EVERY value with no visible text,
not only a fully refused one — WC-2026-11-13-external-empty-entry-dropped.
