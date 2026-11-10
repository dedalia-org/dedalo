# WC-077 — `dd_component_text_area_api` ported: `get_tags_info` + `delete_tag` (2026-07-30)

The whole API class was missing from the TS engine, so `tool_tr_print` answered
**HTTP 400 "Undefined or unauthorized method (action)"** the moment it opened
(the class was never in `ACTION_REGISTRY`; API-01 is working as designed — the
gap was the port, not the gate). `get_tags_info` is now registered
(`src/core/api/handlers/dd_component_text_area_api.ts`, producer
`src/core/components/component_text_area/tags_info.ts`), resolving the marks a
transcription's text carries into the records they point at:

- **`tags_index` / `tags_reference`** — `[{data:<stored locator>, label:<term>}]`
  (PHP `get_tags_data_as_terms`, 'array' format). Source component =
  `properties.tags_<type>.tipo`, read on the HOST record; the config's own
  `section_tipo`/`section_id` ('self' on the shipped ontology) are ignored, as
  in PHP. The label resolves through `getTermByLocator` (scope `thesaurus`),
  the same resolver every relation list uses.
- **`tags_notes`** — `[{data:<note locator>, <ddo id>:<value>, …}]` (PHP
  `get_annotations`): the text is scanned with `NOTE_PATTERN`
  (`resolve/tr_marks.ts`, payload = group 6) and each mark's locator resolved
  through `properties.tags_notes[<section_tipo>]`. **Literal ddos emit
  `string[]`, not stored `{id,lang,value}` items** — the shipped client renders
  them directly (`note.title.join(' | ')`, `note.body` concatenated into a
  template), which is what v6's `get_dato()` string arrays gave it; serving raw
  items would print `[object Object]`. A `type:'bool'` ddo emits a real boolean
  (`component_publication` `section_id === '1'`). A malformed mark payload is
  skipped (PHP logged and continued).
- **`tags_persons`** — the same producer as the EDIT emit feed
  (`tags_persons.ts`, WC-065), so the two paths cannot drift.
- **STRING ids** — every `section_id` and `tag_id` in the payload is a string
  (the WC-065 rule applied here): the client matches this feed against values
  it scraped out of the text with strict `===`.
- **Property gating** — a tag type whose `properties.tags_*` is absent yields
  NO key at all (PHP `isset` gating), never an empty-array lie. An
  ar_type the engine does not know is NAMED back in `msg` instead of silently
  dropped.
- **AUTHZ-01, TS-stronger** (spec §3 permits stronger): the host record is
  `principalCanAccessRecord`-gated before anything resolves — this feed reads
  the content of the record AND of every record its tags point at. PHP resolved
  for any coordinates a logged-in user named.
- **Lang scope** — notes and text resolve in the request's data lang (or
  `source.lang` when the client names one), with NO fallback chain, matching
  PHP `get_dato`. Consequence, unchanged from PHP: `tool_tr_print` renders every
  lang slice of the text but resolves notes only for the component's own lang.

### `delete_tag` (added later the same day)

PHP's second action on this class — tool_indexation's step 1, "remove this index
tag's marks from EVERY language of the text" (its step 2, the portal locator, is
`dd_component_portal_api::delete_locator`, which PHP deliberately moved out of
this action and the client calls right after). Until it landed, deleting an
index tag removed the locator and left orphan `[index-n-58-…]` /
`[/index-n-58-…]` marks in every language. Producer:
`src/core/components/component_text_area/tag_delete.ts` (PHP
`delete_tag_from_all_langs` :639 + `delete_tag_from_text` :713).

- **Only the PAIRED mark families are deletable by id: `index` and
  `reference`** (`ID_TARGETED_MARK_TYPES` in `resolve/tr_marks.ts`). PHP's
  `get_mark_pattern` had id branches for note/person/lang/geo/page/draw/svg too;
  those are NOT exposed — deleting a note's mark would orphan the note RECORD,
  and no client asks for it. An unsupported type is REFUSED with the type named,
  never treated as a no-op success.
- **The tag id is VALIDATED, not interpolated.** PHP dropped `$id` straight into
  the regex source (`class.TR.php:53`). `markPatternById` accepts only
  `/^[0-9]{1,6}$/` — the grammar's own id shape — and THROWS otherwise: one
  check that is the pattern-injection guard, the ReDoS guard and the grammar
  rule at once. A malformed id is a rejected request (`errors:['bad_options']`),
  not a 500.
- **The lang list is the langs that HOLD DATA**, in stored order — PHP's
  `get_component_ar_langs` returns the keys of the component's lang-keyed data
  (`class.component_common.php:2476`), so no slice that does not exist is read
  or written.
- **ONE save per language, NO outer transaction** — deliberately unlike WC-061.
  Atomicity was mandatory there because retrying a partial timecode offset
  DOUBLE-applies it; mark deletion is IDEMPOTENT (a retry re-runs a pattern that
  no longer matches), so a mid-loop failure is recoverable by re-issuing the
  request, and the response names the langs already cleaned
  (`langs_changed`) plus the error. Wrapping the loop would also drag
  `saveComponentData`'s deliberately post-commit hooks (permissions-cache
  invalidation, observer propagation — rsc36 declares `observers`) inside the
  transaction. Consequence on the wire: **one Time Machine row per changed
  language**, and none at all when nothing matched.
- **`result` semantics are PHP's and are LOAD-BEARING**: `result = (removed >
  0)`. The client only strips the editor's own tag markup when
  `result!==false` (`component_text_area.js:1372`) and tool_indexation alerts on
  false — so "nothing matched" MUST stay falsy. Message bytes are PHP's
  (`Deleted tag: <id> (<type>) in <n> langs: <langs> (<model> - <tipo>)` /
  `No tags are deleted in <model> tipo: …`). TS ADDS two informational fields
  the client ignores: `langs_changed`, `removed_count`.
- **Write gate = the canonical one** (`dd_core_api` save): `getPermissions >= 2`
  on the (section, component) pair, then `isRecordInScope` for non-admins —
  NOT the weaker `isGlobalAdmin`-only check `deletePortalLocator` still carries.
- **Side effect of the full-slice write**: the rebuilt slice passes through
  `sanitizeRichTextChanges`, so a tag delete also strips legacy
  `<script>`/`<svg>` from that language's text. Same posture `tool_tc` already
  has; the sanitizer is a denylist and leaves formatting intact.

Gates: `test/unit/tags_info.test.ts`, `test/unit/text_area_delete_tag.test.ts`.


---

## Addendum 2026-11-10 — AUTHZ-01 corrected and replaced by the read door (T0-3)

**The AUTHZ-01 bullet above misstated PHP.** PHP did NOT "resolve for any
coordinates a logged-in user named": frozen `class.dd_component_text_area_api.php:205`
asserted `security::assert_section_permission($section_tipo, 1, …)` first. TS
until this addendum was therefore not "stronger" — it swapped PHP's section grant
for the record scope (weaker on one axis, stronger on the other), and consulted
neither the text_area's own grant nor any grant on the records the tags point at.

**The law now** (WC-2026-11-10-tags-info-read-door, owner OD-1 (c)):

- the HOST door is the write door's READ mode (`authorizeRecordAccess`,
  `{mode:'read', level:1, sectionFloor:1}`): section >= 1 (PHP parity restored)
  → the text_area's pair grant → the record scope (`perm.out_of_scope`);
- it runs BEFORE the options are parsed (an unauthorized caller with a bad
  `ar_type` gets `perm.denied`, never `request.invalid_options`);
- every HOP is gated with the same principal: note records (dropped + named in
  `withheld_notes`), the host tag-source component of index/reference, and the
  persons inverse search (scoped).
