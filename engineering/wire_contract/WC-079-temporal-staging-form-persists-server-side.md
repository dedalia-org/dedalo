# WC-079 — the temporal staging form persists SERVER-side, per user (2026-07-30)

`service_tmp_section` (the "Values" form behind `tool_import_files` /
`tool_import_marc21` / `tool_import_zotero`) builds its children with
`element_instance.build(true)` — autoload ON — so every render re-read through
the TEMPORAL door and got the `entries: []` WC-059 guarantees. **Everything the
operator typed was silently wiped on any reload**, losing the metadata for a
whole import batch.

This adds a TS-native scratch store. **WC-059's storage half is superseded; its
load-bearing half is not** — a temporal instance still ADDRESSES NO RECORD, and
nothing here writes to matrix record 1, its Time Machine rows or its activity
rows. `temporal_instance_tripwire` passes unmodified, including the assertion
that `temporal.ts` reaches zero matrix write engines.

(An earlier attempt the same day persisted these values in the browser via
IndexedDB. That was reverted in favour of this store — persistence now follows the
OPERATOR, not the browser, and no client-side scratch remains.)

### The opt-in is a SEPARATE field, not `is_temporal`

`source.temporal_scope` — a string naming the OWNING TOOL, emitted **only** by
`service_tmp_section` (from `self.caller.model`), forwarded by
`component_common` → `create_source`.

`is_temporal` answers *"does this address a record?"*; `temporal_scope` answers
*"should this persist?"*. Conflating them is how one producer's need becomes five
producers' bug: of the five temporal producers only `service_tmp_section` wants
persistence, and the other four would be **corrupted** by it —
`tool_propagate_component_data` seeds its clone from the OPEN record and then
bulk-writes across a whole search result set; the two `component_text_area` pickers
(draw + reference) are transient, so a restored value there is a stale locator
stamped into a tag; and `view_graph_solved_section`'s fallback instance is built
for its CONTEXT only and never saved, so it has no value to persist. All four send
no scope, so their behaviour is byte-identical to before.
`is_temporal` also keeps its single-reader tripwire: the store calls the exported
`isTemporalSource()` predicate rather than reading the wire literal.

### The key: `(user_id, scope, section_tipo, component_tipo, lang)`

Five discrete columns, the table's PRIMARY KEY, never a concatenated string.
PHP's `matrix_temp_manager::get_uid` built `section_tipo . user_id` with no
separator, so `'oh1'+42` and `'oh14'+2` addressed the SAME row — two different
users on two different sections — and it omitted the owning tool entirely, so two
tools open on one section clobbered each other. `scope` is that missing
discriminator; `user_id` is the tenancy boundary and appears in **every**
statement except the age-scoped TTL sweep.

`user_id` comes from the session — `principal.userId` on the write door,
`currentPrincipal()` on the read door — and **never from the request body**. The
address type carries no user field by construction, so a key built from a wire
source is structurally incapable of naming a user.

### What is stored is RAW

Literal items, or relation **LOCATORS** — never resolved chips. Labels are
language- and permission-dependent, so a stored chip would freeze a label the
next reader may want in another language or may not be allowed to see. The
relation write therefore persists `picked` BEFORE `resolveRelationEcho`, not the
chips that call returns.

### Reads resolve through the STANDARD pipeline (record grafting)

The read does not re-implement resolution. It materialises a virtual record,
grafts the stored value with `injectComponentData`, and lets the ordinary
pipeline run — the same pattern the Time Machine override and
`component_relation_children` already use for values not stored on the addressed
record. `expandPortal` then produces real labelled chips and a real pagination.

This mirrors the PHP oracle, which built a **fake matrix row** in
`matrix_temp_manager::read()` and let `component_portal_json.php` →
`common::get_subdatum()` resolve against the real matrix; the temp manager itself
resolved nothing.

The graft goes in under `resolveDataTipo(tipo)`, not the ddo tipo — both
`expandPortal` and the select-family resolver look the slot up by the DATA tipo,
so an aliased component (WC-020) would otherwise graft into a slot nothing reads.

**(!) The empty-set trap.** `expandPortal` returns early on an empty locator set
and emits NO item at all. Falling through with nothing staged would leave the
client's `self.data = data || {}` without an `entries` array — a worse regression
than the bug being fixed. So an empty scratch keeps the bare
`buildDataItem(..., [])` and only a NON-empty one falls through.

### Lifecycle

- **Consume** — each tool clears its own scope at the end of its `import_files`
  server handler, on SUCCESS only (a failed import keeps the form for a retry).
  Server-side on the code path that consumed the values, not a client hook: that
  is what survives a closed tab, and what gives `tool_import_marc21` /
  `tool_import_zotero` the same behaviour without either growing an `on_done`
  handler they never had.
- **TTL** — an opportunistic prune on write (the `error_report/store.ts`
  retention precedent), 72h, index-supported. PHP never deleted a temp row at
  all; its only reclamation was Postgres truncating the UNLOGGED table on crash.
  This table is LOGGED: an unclean restart must not eat a half-filled form.
- Steady-state size is "form fields a user has touched", not "edits performed" —
  every write is an UPSERT on the natural key. A 256 KB per-row cap stops a
  client using it as a blob store.

### Component TOOLBARS are suppressed on a temporal element

Every tool on the strip acts on a RECORD — time-machine history, propagate this
value across a search result set — and a temporal clone addresses none, so each
is inert or actively wrong. `buildStructureContext` now takes `isTemporal` and
ships `tools: []`; the client renders from `self.tools || []`, so no client
change was needed. A deliberate divergence from PHP, which shipped the strip.

Gates: `test/unit/temporal_scratch_store.test.ts` (round trip, per-user
isolation, cross-tool/section/lang non-collision, `jsonb_typeof = array` against
the `::text::jsonb` bind trap, TTL prune, and the scope gate that pins the other
four producers persisting nothing), plus the unmodified `temporal_door_native`
and `temporal_instance_tripwire` suites.

Verified against the running engine: a literal and a portal locator both survive
a full page reload, the portal rendering as a resolved labelled chip
("Ajuntament de Bon-Encontre") with `pagination {total:1, limit:10}`; a read
without a scope still answers `entries: []`; the component toolbar is absent from
every element of the form; and a completed import clears the rows.

### Hardening after adversarial review (same day)

The first cut of this store shipped two defects that a multi-agent review caught
and reproduced. Both are fixed; both are worth recording, because both are the
kind of bug that only appears once a value becomes DURABLE.

**1. Cross-tenant read (AUTHZ-02).** The grafted locators are CLIENT-SUPPLIED —
the save door persists `picked` *before* `resolveRelationEcho` applies its scope
filter, admits at a READ grant, and `read_facade` exempts temporal sources from
the per-record gate ("the sentinel addresses no record", true before this store,
false after). Grafting them unscoped let a level-1 user POST a locator for any
record, then read back that record's field values through the standard expansion.
Reproduced live: 129 items including another tenant's field values.
Fixed by scoping the stored locators through the SAME filter the search-chip door
uses — now extracted as `filterLocatorsInScope` (`security/record_scope.ts`) and
called from **both** doors, so they cannot drift again. Applied at READ time, not
only write time: a projects assignment can change after a row is written.

**2. Paginated truncation (silent data loss).** `payload.entries` is only the
current PAGE of a portal, and the write is a wholesale UPSERT. Staging 15 records
then linking a 16th shipped a 10-item page, and the store's 15 became 11 — five
staged relations gone, no error, invisible until the import ran. Fixed by seeding
the delta from the STORE when a row exists (`readTemporalScratchBase`), so the
durable set is authoritative and the client's page is only a fallback. Stable
`id`s are minted on the stored set at the same time, because `remove` matches by
id and a post-reload unlink was otherwise a silent no-op.

Also hardened: the consume-clear now fires only when something was actually
imported (`result: true` is returned even when every file failed); a refused
oversize write DELETES any previous row rather than leaving a stale value to be
restored as though current; and a per-user row cap bounds the wire-controlled
`scope`/`lang` key columns, which the TTL bounds in time but not in count.

Gates added with the fixes: `test/unit/temporal_scratch_door.test.ts` exercises
the wiring through `dispatchRqo` against the REAL table (the store's own suite
uses an injectable scratch table and would pass even if the door were never
wired), covering the scoped round trip, the unscoped no-persistence contract, the
empty-set trap on both the portal and literal seams, cross-user invisibility, and
`tools: []` **with a non-temporal control** so the suppression cannot pass
vacuously. `filterLocatorsInScope` is pinned in `temporal_scratch_store.test.ts`,
including the case that actually proves the tenant boundary: a REAL record
locator is DROPPED for an out-of-scope non-admin and KEPT for an admin — the
admin half being the control, without which the drop could equally mean the query
errored or the record does not exist. `temporal_instance_tripwire` now also freezes the single reader and the
client producers of `temporal_scope`, mirroring what it already does for
`is_temporal` — without that, the safety argument for the opt-in was unenforced
prose and a fifth producer could have opted itself in silently.

---

## Addendum 2026-11-12 — tool_import_marc21 applies the form before consuming it

tool_import_marc21 cleared its staging form after a run without ever applying
it: `components_temp_data` was read nowhere, so the consume-clear threw the
operator's Values away. It now applies every non-empty `input_component` field
to each imported record (`src/core/tools/import_form_values.ts`, shared with
tool_import_files) BEFORE the clear, so "consume" is true again. Gate:
`test/unit/tool_import_marc21.test.ts` G11/G12.
WC-2026-11-12-marc21-config-map-and-transforms.
