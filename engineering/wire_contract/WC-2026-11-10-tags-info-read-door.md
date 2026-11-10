# WC-2026-11-10-tags-info-read-door — get_tags_info asks the section, the text_area, the record scope and every hop

- **Date:** 2026-11-10 (T0-3, owner decisions of 2026-11-10: OD-1 (c) host door + hops,
  OD-2 (a) drop + name a refused note in `withheld_notes`, OD-3 (a) term labels "as
  displayed"). Gate site: `get_tags_info` (`src/core/api/handlers/dd_component_text_area_api.ts`)
  through the write door's READ mode (`authorizeRecordAccess`,
  `src/core/security/write_door.ts`); hops in `buildTagsInfo`
  (`src/core/components/component_text_area/tags_info.ts`).
- **Decision:** DEC-12. Stricter than PHP on the component grant, the hops and the error
  order; PHP parity restored on the section grant. Amends WC-077 AUTHZ-01 (see its addendum).

## Shape before (PHP, and TS until this entry)

```
{action:'get_tags_info', dd_api:'dd_component_text_area_api',
 source:{tipo:TA, section_tipo:S, section_id:N, lang}, options:{ar_type:[…]}}
```

- **PHP** (frozen `class.dd_component_text_area_api.php:205`): `assert_section_permission(S, 1)`
  only. No grant on the text_area, none on note records, the host tag-source components or the
  persons' referencing records; no record scope.
- **TS until this entry**: the record scope only (`principalCanAccessRecord` → `perm.denied`),
  checked AFTER the `ar_type` refusal. No section grant (PHP's own gate was lost), no component
  grant; notes were read with no grant and no scope; the persons inverse search ran unscoped
  (`buildRelatedSections` without `principal`).

## Shape after (TS)

In order:

1. coordinates (`request.invalid_source`, unchanged);
2. THE HOST DOOR — section >= 1 → `perm.denied`; the text_area pair grant
   (`authorizeComponentRead`) → `perm.denied`; the record scope → **`perm.out_of_scope`** (was
   `perm.denied`; `section_id 0` included);
3. `options.ar_type` (`request.invalid_options`) — now AFTER authz;
4. the payload, every hop under the same principal:
   - **notes**: a note is served only when every `tags_notes` ddo's (note section, component)
     pair is granted AND the note record is in scope. A refused note is DROPPED from
     `data.tags_notes` and its `section_id` NAMED in a new owned top-level key
     **`withheld_notes`** (array, always present, `[]` when nothing was withheld). The id is
     already in the transcription's own mark — naming it discloses nothing;
   - **index / reference**: the host tag-source component (`tags_<type>.tipo`) needs its own
     pair grant on the host section; refused → the type's key is ABSENT. Term labels pass "as
     displayed" (no per-term section grant — the D4 export precedent, 0cf7561941);
   - **persons**: two rules. (i) The inverse related search is scoped to the caller — an
     out-of-scope referencing record never feeds `tags_persons`. This narrowing happens IN SQL
     and is SILENT BY DESIGN: no log line, no notice, because a notice per dropped owner would be
     an existence oracle of records the caller may not see. (ii) Each owner record's persons
     component (`tags_persons[…].component_tipo`; for a self entry the owner is the host) needs
     its own (owner section, component) pair grant (`doorComponentAllowed`, memoized per
     (section, component) within one call) — the same rule as the index/reference tag source.
     A refused owner contributes nothing (`buildTagsPersons`,
     `src/core/components/component_text_area/tags_persons.ts`). The EDIT emit feed of the same
     producer (`component_text_area/emit.ts`) passes no principal (an internal read, unchanged —
     `EmitHookContext` carries none);
   - every OTHER hop refusal (note, tag source, persons component grant) is recorded by the read
     door's recorder: a `[frontier] REFUSED` log line and a `notices:[{code:'perm.out_of_scope'}]`
     entry on the `ok:true` envelope (ONE notice per response — the request's notices dedupe by
     code).

```
{ok:true, data:{tags_index:[…], tags_notes:[…]}, unknown_types:[], withheld_notes:[937342],
 notices:[{code:'perm.out_of_scope', label_key:'error_perm_out_of_scope', retryable:false}]}
```

## Reason

The feed resolves the CONTENT of the host record and of every record its tags point at; a
project-scoped user whose profile denies the host section, the text_area or the notes section
read the full transcription payload and the note bodies. The client (`tool_tr_print`, the only
caller) already tolerates every narrowed shape: a mark's note is looked up with `Array.find` over
`tags_notes || []` and a mark with no note renders as nothing (`render_tool_tr_print.js`
`get_note` → `''`); an absent `tags_index` is read as `|| []`. A whole-call refusal behaves as
any refusal of this feed already did (the `get_tags_info` promise in `component_text_area.js`
never resolves on a failed request — pre-existing, not changed here).

## Gate reconciliation

`test/unit/tags_info_read_door_native.test.ts` (reader/control PAIRS on the `zztags` situation:
no section grant, text_area 0, note section 0, note component 0, note record out of scope,
tag-source 0, persons scope, persons component 0, authz-before-options — all RED before this
entry; the persons-component pair (persona `NO_PERSONS_COMPONENT`, `zztags9` at 0) was proved
RED on the code before rule (ii)).
`text_area_tags_info_action_native` re-pinned: authz before options; `section_id 0` →
`perm.out_of_scope`; its superuser is root (-1), whose section/pair grants answer by rule.
No parity fixture records `get_tags_info` (the action was ported after the harvest froze).
