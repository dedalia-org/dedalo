# WC-2026-08-09-record-birth-defaults — record defaults are seeded at the CREATE door, not on the first edit-form build

- **Date:** 2026-08-09 (audits/2026-08_oh1_beta REPORT §2 + §5.1, blocker **B1**:
  *"No default project seeded on record create… the new record is invisible in
  list and search, every save returns 403 'Record is out of the user scope', it
  cannot be opened or deleted"*, and *"`properties.dato_default` is implemented
  nowhere in `src/`"*). WS-1 "Record creation integrity".
- **Decision:** DEC-15 (deliberate divergence), DEC-12 (tripwire in the same
  change).

## What was wrong

`component_filter` (`oh22` on Oral History, `rsc28` on the audiovisual/image
family, …) carries the project locator the projects ACL filters every read and
every per-record write gate by. **No TS door wrote it.** All 76 PHP-era `oh1`
records carry their `oh22`; the single TS-created one did not. For a
non-global-admin cataloguer — every real beta user — the record was therefore
born outside their own scope: absent from list and search, 403 on save,
unopenable, undeletable.

The same hole had a generic sibling: `properties.dato_default`, the ontology's
declaration of a component's initial value (`oh21` Quality, `oh93` Review
status, `oh32` publication "No", the hierarchy colour and section_tipo…), was
implemented nowhere, so 44 declared defaults in the dev ontology and 66 in the
production one never landed.

## Shape before (PHP) — a RENDER side-effect

PHP writes both seeds when an edit form is BUILT, not when the record is made:

- `component_common::__construct` (`class.component_common.php:681-687`) calls
  `set_data_default()` whenever `mode === 'edit'`, `data_source !== 'tm'` and
  `section_id > 0`; `set_data_default` (`:753-869`) resolves
  `properties.dato_default`, checks `get_component_permissions() >= 2`, and — if
  the component's own data is still empty — `set_data()` + `save()`s it.
- `component_filter` overrides that method (`class.component_filter.php:196-262`)
  with the project cascade in `get_default_data_for_user` (`:302-470`).

The v6 CREATE-time twin, `section::set_projects_to_new_section_record`
(`class.section.php:642-750`), survives in the frozen tree as **private dead
code**: nothing calls it, and `create_record`'s own docblock says so
(`:392-394`, *"Does NOT set the project filter on the new record"*).

Two tiers of PHP's filter cascade are INERT in the frozen oracle and are
therefore not ported:

1. `CONFIG_DEFAULT_FILE_PATH` — a per-install JSON override file. The `define`
   is commented out in every shipped config, so the tier never ran; there is no
   config key for it here.
2. `component_filter`'s own `properties` tier — PHP guards it with
   `isset($properties->data_default)` but reads `$properties->dato_default`. No
   `dd_ontology` row in any install carries `data_default` (0 rows against
   44/66 `dato_default` rows in `dedalo7ts` / `dedalo7_mht`), so the branch is
   unreachable. Reproducing the typo would be pointless; honouring the property
   instead would silently move an existing install's new records into a
   different project. Parity wins: `component_filter` resolves through the
   config/user-projects cascade.

## Shape after (TS) — one create-door chokepoint

`createSectionRecord` (`src/core/section/record/create_record.ts`) now builds
the record's whole birth state through
`src/core/section/record/record_defaults.ts` and carries it in the SAME INSERT
as the audit metadata:

| seed | value |
|---|---|
| `component_filter` | non-admin with `dd170` projects → their FIRST project; otherwise `DEDALO_DEFAULT_PROJECT` / `DEDALO_FILTER_SECTION_TIPO_DEFAULT`, read through the typed config |
| every other component | its `properties.dato_default`, normalized to stored shape |
| `meta` | the per-component item-id counters the seeded ids consume |

### Normalization is GENERIC — there is no model whitelist

`set_data` (`class.component_common.php:918-1010`) is model-agnostic. It wraps a
non-object element into `{value: …}`, stamps `lang` **only** when the class
declares `supports_translation` (`component_string_common` subclasses +
`component_iri`) and only when the element has none, allocates the item id from
the per-component counter (`set_data_item_counter` → `allocate_component_ids`),
and then calls `validate_data_element` — which has exactly TWO implementations
in the whole oracle:

- the base one (`:901`) returns the element **unchanged**;
- the relation-family one (`component_relation_common.php:1058-1198`) fills
  `type` from the component's own relation type, forces `from_component_tipo`,
  casts `section_id` to STRING, strips `paginated_key`, and REJECTS (an ERROR
  log + drop, never fatal) a bad-formed or duplicate locator.

So `component_date` keeps its `{period:…}` / `{start:…}` object, `component_json`
keeps its whole config object, a `component_number` scalar becomes `{value: 7}`
— each with only an `id` added. Byte-verified against real records (`oh1`'s
`oh21`/`oh93`/`oh32`, the `hierarchy101` colour default, the stored
`{id, start:{…}}` `component_date` shape).

The FIRST implementation of this entry whitelisted "relation family OR
translatable literal" and threw for every other model. That is a silent
narrowing of capability wearing a loud throw's clothes, and it was not
theoretical: `dedalo7_mht`'s `nexus40` (`nexus52` is `component_json`) and
`dedalo7_mdcat`'s `dmm1` (`dmm263/4/5` are `component_date`) became
**uncreatable through every door**. The only shape that still throws is
`{"method": …}` — PHP resolves it through `component_common::get_method`, the
path is genuinely unported, and no `dd_ontology` row in any install uses it.

### Which components a record has

The walk is the **virtual EDIT scope** (`resolveVirtualEditScope`, the same
resolver the edit form and the elements context use): a virtual section
(`rsc170` → `rsc2`, `es1` → `hierarchy20`) borrows the REAL section's
components MINUS the tipos named by its FIRST `exclude_elements` child. A
`WHERE parent = <virtual tipo>` walk returns only
`exclude_elements`/`section_list`/`buttons`, so preferring a virtual section's
"own" components would drop the real section's entire declared default set.

### The portal "+" — TWO PHP rules, not one

`relations/save.ts` `applyAddNewElement` passes the HOST record's project
locators in as `filterData` (PHP's `create_record` `values` argument) after
intersecting them with the CALLER's own projects
(`component_common::get_current_section_filter_data:5199`, *"only intersections
are accepted"*).

When that yields NOTHING — an empty intersection, a host with no projects, a
host section with no `component_filter`, or a TEMPORAL instance
(`is_temporal===true` short-circuits the read to null) — PHP `add_new_element`
handles the empty case **itself** (`component_relation_common.php:3798-3813`)
with `DEDALO_SECTION_PROJECTS_TIPO` / `DEDALO_DEFAULT_PROJECT` /
`DEDALO_RELATION_TYPE_FILTER`. It never calls
`component_filter::get_default_data_for_user`, so the caller's own FIRST project
— which IS the create door's answer for a non-admin — is deliberately **not**
the fallback here. Falling through to `resolveDefaultFilterData` was an
undeclared divergence and is removed; `defaultProjectFilterData()` builds PHP's
locator from the typed config. The previous hardcoded
`{section_tipo:'dd153', section_id:'1'}` is gone either way: there is no
hardcoded project locator left in the engine.

Note the further asymmetry, which is PHP's own and stays:
`get_current_section_filter_data` has NO global-admin exemption while
`get_default_data_for_user` does, so an admin's portal "+" also lands in
`DEDALO_DEFAULT_PROJECT` rather than the host's project
(pinned by `portal_edit_writes_native.test.ts`).

### test3

`section_tipo === 'test3'` stays excluded from the filter seed, exactly as PHP
excludes it (`class.component_filter.php:230`). ONE micro-divergence, stated
rather than left silent: the exclusion is applied at the create door, so it also
suppresses the portal "+"'s *inherited* filter into `test3`, which PHP would
have written (its exclusion lives in `component_filter::set_data_default`, not
in `add_new_element`). `test3` is the PHP unit-test sentinel playground whose
whole purpose is to hold no real project assignment; the wider exclusion serves
that purpose rather than defeating it.

## Reason

**The divergence is WHEN, not WHAT.** For a newly created record the end state
is PHP's; the difference is that TS writes it at the create door instead of as
a side effect of rendering an edit form. Three reasons that is the correct
chokepoint and the render hook is not:

1. **Coverage.** Import, `dd_ts_api`, the MCP write tools, the portal "+" and
   duplicate never build an edit form. Under PHP's rule a record made by any of
   them stays project-less until a human happens to open it — which they cannot
   do, because opening it is what the missing project locator forbids.
2. **A read must not write.** PHP's seed fires from a constructor during a GET,
   which is why it needs its own level-2 permission check (a read-only user can
   open an edit form). At the create door the caller has already passed the
   level-2 create gate, so the check is structural rather than defensive.
3. **No intermediate invalid state.** One INSERT carries the defaults, so the
   record is never momentarily outside the projects ACL, and no Time Machine row
   records the record's own birth state as if it were a change.

The observable consequences of the timing difference are: (a) TS seeds records
that are never opened in edit, where PHP would have left them empty; and (b) TS
does NOT retro-seed a LEGACY record whose component is still empty when a user
opens it in edit — PHP did. (b) is deliberate: a silent write during a read on
somebody else's historical record is the same anti-pattern as (2), and the
records that need it can be reconciled explicitly.

## Gate reconciliation

- `test/unit/record_defaults_native.test.ts` — the B1 gate. Headline: a record
  created as a NON-global-admin (a scratch `dd128` user carrying one `dd170`
  project that is deliberately NOT `DEDALO_DEFAULT_PROJECT`) comes out with that
  project's locator and passes `isRecordInScope` — the precise gate that
  answered 403. Also pins: the admin / projects-less fallbacks; the `oh21`,
  `oh93`, `oh32` normalized locators; the literal `{id,lang,value}` shape; the
  seeded item-id counters; the `test3` exclusion; the portal "+" actor,
  intersection, empty-intersection default project, temporal door and `NEW`
  activity row; a static pin that no hardcoded `dd153` locator remains.
  **RED before the change** (9 of 17 cases), green after.
  - **THE ANTI-WHITELIST TRIPWIRE** lives here (DEC-12: the invariant "PHP
    handles EVERY model generically" gets its mechanical gate in the same
    change). Two halves, because either alone is defeatable: an
    install-INDEPENDENT sweep asserting `normalizeDefaultItems` succeeds for
    **every registered component model** (a whitelist keyed to whichever models
    the local DB happens to declare defaults on is not a gate), plus a census
    that `buildRecordDefaultColumns` throws for NO `model='section'` node in
    this install. Verified red against the whitelisted shape: 5 failures,
    including `component_date` and `component_json` by name.
  - The virtual-section walk and the ontology-cached per-section spec are pinned
    here too (the spec's object identity across `clearRecordDefaultsCache`).
- `test/unit/create_record_audit.test.ts` — **the DEC-14b survival twin of the
  retired `test/parity/create_differential.test.ts`, and the golden this entry
  is measured against.** PHP's `create_record` writes ONLY `dd200` into
  `relation`; TS now writes the birth defaults there too. Reconciled WITHOUT
  weakening: the `dd200` locator stays pinned verbatim, and a second case pins
  the relation column to `dd200` **plus exactly** what
  `buildRecordDefaultColumns` derives from the ontology for that section
  (`numisdata6` → `numisdata127`, `numisdata266`, `numisdata434`). Any key that
  is not the audit stamp and not an ontology-declared default still reddens.
- `test/unit/hierarchy_provision_native.test.ts` — provisioned ontology node
  records now carry `ontology26` (project filter) and `ontology30` ("Is model"
  → `dd64/2` no). The key-set pins were updated because the OLD ones were the
  TS-only impoverished row: all 41 `ontology0` records in the dev install and
  all 41 in the production one carry both keys. A per-caller
  `seedDefaults:false` was rejected — a record's ontology-declared birth state
  does not depend on which door made it. An added case pins that the
  provisioner still OVERWRITES `ontology30` with `dd64/1` on the model twin (a
  model twin left at the "no" default would stop parsing as a model).
- `test/unit/dataframe_cascade_removal.test.ts` — its fabricated
  `{isGlobalAdmin:true, userId:1}` no longer passes `deletePortalLocator`'s
  restored level-2 gate (user 1 holds no `dd1725` profile in the suite DB, and
  PHP `common::get_permissions` has no admin bypass). Changed to the superuser,
  which short-circuits to 3. The gate itself is pinned on REAL level-0 /
  level-2 users in `record_defaults_native.test.ts`; this file gates the
  dataframe cascade, not permissions.
- **No re-harvest.** The frozen oracle store contains no create-then-read
  fixture for these components; the PHP shape above is recorded from the frozen
  source, as a fossil.

## Addendum 2026-08-09 — the delete_locator gate is not a divergence

The same change fixes `deletePortalLocator` to `getSectionPermissions(...) >= 2`
(PHP `security::assert_section_permission($section_tipo, 2)`) instead of an
`isGlobalAdmin` flag. That is a RESTORATION of PHP behaviour, not a divergence,
and needs no entry of its own — it is noted here only because it lands in the
same file and the same gate.

**Superseded 2026-10-01** by WC-2026-10-01-delete-locator-write-door: the section-only gate
is replaced by the write door (section floor 2 + the pair + the record scope) — a deliberate
divergence from PHP.

## Addendum 2026-11-21 — no retro-seed: RULED, the manual corrected, a report-only census added (T2-SL-7, owner Q3)

- **Ruling (owner, 2026-11-19, Q3 / O14):** the engine stays as this entry ships it — a
  default is written ONLY when a record is created; a read never writes. The v6 behaviour
  (the first edit-form build of an EXISTING record seeded its empty default-bearing
  components) is **not** reproduced, by decision, not by omission.
- **Who is affected:** records that existed before their section declared a default, and
  Dédalo v6 records nobody opened in edit before the upgrade. They keep their empty field. The
  engine cannot tell them from a value a curator cleared on purpose, so nothing fills them.
- **The manual said otherwise** (`docs/core/components/component_input_text.md`: "edit … applies
  `dato_default`"; `component_radio_button.md`: "seeds the value in edit mode when the stored
  data is empty"; `component_number.md`: "Not ported"). Corrected; the rule is stated once in
  `docs/core/ontology/authoring.md` → *`dato_default` — a default is written when the record is
  created*.
- **The census:** reconcile `record_missing_defaults`
  (`src/core/section/record/missing_default_check.ts`, registered in
  `src/core/reconcile/registry.ts`; Maintenance → Reconcile, `scripts/reconcile.ts`, dry in
  the post-restore plan). It compares each section's declared defaults — the create door's own
  spec, `getSectionDefaultsSpec` — with that section's records, and lists per section and
  component the records whose key is absent, null or an empty array (`missing` = the full
  count, `section_ids` = the first 50). **Report-only:** its apply is refused at the registry
  (`applyRefused`); the operator fills the records they mean to with the propagate tool.
- **Gate:** `test/unit/record_missing_defaults_native.test.ts` (the create door seeds; absent /
  null / empty keys reported, a held value not; an edit read leaves the report unchanged and
  the run writes nothing; apply refused; scope) + the registry's pair proof
  (`reconcile_registry_native` PLANTERS.record_missing_defaults).
- **Gate reconciliation:** TS-native only; no fixture, no re-harvest.

## Addendum 2026-11-22 — the tree's "+" adds no flag value of its own (T2 THES-04/05, owner M4)

- **Before:** `add_child` (`src/core/ts_object/ts_api.ts`) staged `dd64/1` (Yes) on the
  section_map's `thesaurus.is_descriptor` and `thesaurus.is_indexable` components AFTER the
  create door had seeded the record — overwriting a declared `dato_default` (a component
  declaring `dd64/2` was born `/1`), inventing a value where none was declared, writing the
  section_id as the STRING `'1'`, and logging the re-written birth state as a save (one Time
  Machine row per flag).
- **After:** the hardcode and both writes are deleted. A tree-created term carries exactly
  what this entry's birth seed writes: a declared `dato_default` (int section_id, no Time
  Machine row — the birth state is not a change, §Reason 3); NOTHING for a flag whose
  component declares no default. The section_map warnings (`Invalid section_map
  'is_descriptor' / 'is_indexable' property from section`) are unchanged.
- **Ruling:** owner 2026-11-19 (M4) — no `dato_default` is added to the master ontology's
  flag components (rsc678, rsc1027, rsc1032, rsc1033, hierarchy4): "the default is not
  correct in there; the user must handle these properties manually". So on the shipped
  ontology a new tree term's is_descriptor / is_indexable start EMPTY. Consequence, stated:
  a child with no is_descriptor value is listed under its parent (the children list reads
  every child) but counts as neither descriptor nor non-descriptor
  (`relations/children.ts getChildrenOfType`), so it does not light `has_descriptor_children`
  until a curator sets the flag. Stated in full (B6 review M1, 2026-11-22): the unflagged
  node renders ITSELF as a descriptor (`is_descriptor` starts true; only an ND `/2` flips it),
  but a parent whose children are ALL unflagged draws no expand arrow and no ND button on a
  fresh read (`render_ts_line.js` link_children) — the client forces the arrow on only in the
  session that added the child. After a reload such a term is not reachable by expanding its
  parent in the tree; it is reached from its section's list until a curator sets the flag. On
  the shipped ontology this holds where the flag component declares no default (measured on a
  suite DB: rsc3→rsc678, rsc75→rsc1027, rsc295→rsc1032, hierarchy1→hierarchy4; the standard
  thesauri hierarchy23/24 and ontology4 declare one). Whether a null flag should count as a
  descriptor for the arrow (the node's own rendering) is an OPEN owner question; current
  behaviour kept and pinned.
- **THES-05:** the string id disappeared with the hardcode. Its sibling at
  `ontology_write.ts` (the registry row's project-filter locator, `section_id: '1'`) was
  verified canonical: it passes `relationLocator`, which stores `canonicalizeStoredSectionId`
  (int).
- **Gate:** `test/unit/ts_api_mutations_native.test.ts` — *addChild — the flags are what the
  ontology declares* on the `zztad` situation: declared `/2` → `/2`; undeclared → no key;
  declared `/1` → one item, int id, zero Time Machine rows for the flag key (the parent link,
  add_child's own write, keeps its one). Red before on every leg; mutations (hardcode on the
  undeclared flag only; on the declared flag only, int id) red. The stated consequence is
  pinned on a third section (`FLAGS_C`, no declared default, a tree row map with an ND icon and
  link_children): child `is_descriptor` true, parent `has_descriptor_children` false, no
  `link_children_nd`; mutation (a null flag counted as a descriptor) red.
- **Gate reconciliation:** TS-native only; no fixture, no re-harvest.
