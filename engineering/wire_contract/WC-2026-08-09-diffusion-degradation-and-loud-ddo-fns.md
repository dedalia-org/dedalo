# WC-2026-08-09-diffusion-degradation-and-loud-ddo-fns — a diffusion run reports what it could not publish

- **Date:** 2026-08-09 (audit `audits/2026-08_oh1_beta/REPORT.md` — blocker B3 and the §5.3 publishing majors).
- **Decision:** DEC-12 ("invariants are tripwired or deleted") applied to the
  publication report: a run that publishes less than the ontology asks for must
  say so. Gate: `test/unit/diffusion_compile_degrade_native.test.ts`.

## What is NOT a divergence (parity restored, recorded so nobody re-litigates it)

Three of the changes in this pass RESTORE the PHP oracle and need no ledger
licence; they are named here because they land in the same commit:

1. **[REPEALED 2026-08-11 — see
   [WC-2026-08-11-diffusion-uninstalled-package-skip](WC-2026-08-11-diffusion-uninstalled-package-skip.md).**
   The `degraded`-step mechanism described below no longer exists: a ddo whose
   TLD carries no ontology content is now DROPPED (taking its column with it,
   an accepted divergence), and a missing node inside an installed package is
   fatal again. Points 2 and 3 of this entry stand unchanged. The paragraph is
   kept verbatim because the oracle facts it cites — `build_datum_context`
   deriving `columns` from the full ddo_map, and the two behaviours PHP keys on
   ddo_map POSITION — are still true and still constrain the compiler.]**

   **A dangling ddo tipo degrades the ddo's VALUE, not the element and not the
   field's SHAPE.** PHP `diffusion_chain_processor::resolve_ddo_value` :133-152 →
   `component_common::get_instance` :394-406 returns null for a tipo absent from
   the ontology, logs it, and returns `[]` for THAT ddo. The TS compiler raised
   a fatal element error instead, so `mht2` (whose four bibliography fields
   reference the absent `zenon4/5/6/9`) could not compile at all.
   **The entry stays in the compiled chain** as a `degraded` ResolveStep that
   resolves to zero atoms. `dd_diffusion_api::build_datum_context` :1288-1308
   derives a datum's `columns` from the FULL ddo_map — every ddo not referenced
   as another ddo's `parent`, with no ontology lookup at all — so a dangling ddo
   IS one of the field's columns, an empty slot the merge joins
   (`empty_columns` defaults to true). Deleting the entry, as the first version
   of this fix did, published `Historia` where the oracle publishes
   `Historia, ` on `rsc1194`, and promoted the SECOND ddo to first — which the
   oracle keys two more behaviours on, both by POSITION in the raw ddo_map:
   the `output_format` fallback (`$first_ddo = $ddo_map[0]`, :1300) and the
   relation-identity stamp (`$is_first_ddo = $ddo_map[0]->tipo === $current_tipo`,
   `diffusion_chain_processor` :243). Degrade the value, never the shape.
2. **`map_section_id_to_subtitles_url` is ported** (PHP `diffusion_fn` :311-339
   + `shared/class.subtitles.php::get_subtitles_url` :682-720). The URL base is
   `/dedalo/publication/server_api/v1/subtitles/` — the same derived `/dedalo`
   application root every other URL this engine builds is rooted at, and byte
   for byte what the ontology node documents in its own
   `properties->process->output_sample` (rsc546).
3. **The dd1758 unpublish queue is retried on a publish run** (PHP
   `dd_diffusion_api::diffuse` :171-183, fire-and-forget, guarded to the first
   chunk by `if (empty($rqo->sqo->offset))`). The TS port had kept only the
   manual admin button. It is retried on the FIRST invocation of a publish job —
   a checkpoint resume continues a run that already paid the debt, which is the
   oracle's own guard.

## Shape before (PHP)

A publish run whose fields could not fully resolve still finished clean:

- a ddo fn PHP does not implement logs an ERROR to the debug log and emits a
  null-valued datum — the run's client-facing response is unaffected;
- a media ddo's `options->test_file`, `options->absolute` and
  `options->default_add` are honoured, and `fn: get_posterframe_url` is the one
  whitelisted media fn (`component_media_common::get_diffusion_data` :470-495);
- the compile-time state of the element is never part of the run response.

The TS port inherited the first half literally: an unported fn on an EMPTY
component slice emitted no atoms and no error, so `validate` reported the
element clean and the run reported success while the AV subtitles column
(rsc546) published empty on every oral-history run.

## Shape after (TS)

The publication-run response (`finishJob` result / SSE final chunk) gains three
new sources of `errors[]` entries, each of which flips `result` to `false` and
`msg` to `Partial success: N error(s) — see errors`:

1. `plan degradation: field '<tipo>' (<label>): ddo tipo '<ddo>' not found in
   the ontology — it resolves to nothing (its column slot publishes empty); the
   field keeps its column topology and its remaining ddos resolve normally` —
   one line per compile-time degradation, seeded before the first batch. When
   other ddos hang UNDER the dangling one the line names them too: they keep
   their column slots and never execute (nothing reaches a child of a hop that
   resolved no locators — the oracle's outcome, previously unstated).
2. `unported ddo fn '<fn>' on component '<tipo>' — refusing to publish an empty
   value that would read as success` — a per-field resolution error, raised
   whether or not the component holds data. **Blast radius, from a census of
   every ddo fn in `dedalo7_mht`, `dedalo7_mdcat`, `dedalo7ts`,
   `dedalo7ts_test` and `dedalo7_development` (2026-08-09):**
   - `get_diffusion_v5_references_html` is the ONE fn firing today. `dd703`
     ('abstract') and `dd704` ('body') carry it as a field-level
     `properties->process->fn`, which the compiler stamps onto every
     auto-generated ddo (PHP `get_ddo_map` :1282-1300 does the same); both are
     columns of `mht2`'s `games` table (mht162) → **2 errors per published
     record until the fn is ported** (PHP
     `component_text_area::get_diffusion_v5_references_html` :2328).
   - `map_target_section_tipo` (hierarchy83 → hierarchy53, component_input_text)
     is configured but LATENT: no element of the `mht ***` domain publishes the
     table that holds it.
   - `get_posterframe_url` appears in NO ontology in the census — the earlier
     version of this entry named it as one of "the two fns this reaches today",
     which the data contradicts. It is a capability refusal (see below), not a
     live error source.
   - Everything else configured anywhere is either ported (`add_parents` — 30
     nodes, all relating to relation-family components, so all compile to the
     hop flag; `get_diffusion_data_info`, `get_geojson_data`,
     `map_parent_to_norder`, `map_section_id_to_subtitles_url`,
     `get_diffusion_iconography`) or INERT: `parser_helper::merge` (5 mht nodes)
     and `parser_text:text_format` (1 dev node) sit on nodes that also declare
     an explicit `ddo_map`, and both engines read a node-level fn only in the
     auto-generated branch.
3. `media ddo '<tipo>': unsupported options <keys> — this engine implements
   quality/extension only` — a per-field resolution error for a media ddo
   option the engine does not implement, raised only when the option is set to a
   TRUTHY value. PHP reads each of them as `$ddo->options->x ?? false`
   (component_media_common :530-536) and uses it as a bool, so
   `"absolute": false` is byte-identical to omitting the key: a ddo that merely
   spells out PHP's own defaults publishes normally. The refusal is about
   capability, not vocabulary.

A fourth `errors[]` source is the unpublish retry: rows still owed AFTER the
retry (or a retry that could not run at all) produce
`pending unpublish queue: N row(s) owed, retried M, K still pending` /
`pending unpublish retry failed: <reason>` in the job row. A queue drained in
full is a LOG line, not an error — flipping a run to "Partial success" because
the system worked would make the signal meaningless.

`validate` (`dd_diffusion_api::validate`) gains a `degradations` array of
`{fieldId, columnName, reason, ddoTipo, disabledDdoTipos, message}` beside
`errors`/`warnings`. The field is additive; the copied client reads neither and
is unaffected.

## Reason

The consumer here is the archivist running the publication, and the failure this
protects against is the one the audit found: a run that looks successful and is
not. PHP's answer — a line in a debug log nobody reads — is not available in
this architecture (the runner is a separate process whose only user-facing
channel is the job row), and it was never a good answer: `mht2`'s subtitles
column had been publishing empty with a green report.

Refusing the media options is the same rule in the other direction. `absolute`
prefixes `DEDALO_PROTOCOL . DEDALO_HOST`, constants this engine DERIVES rather
than configures; `test_file`/`default_add` substitute a placeholder or fallback
file after a filesystem stat that the pure publication primitive does not
perform. Honouring them by ignoring them would publish a URL the ontology did
not ask for — silent narrowing. No install in the census sets any of them
truthy, and none configures `get_posterframe_url`, so the refusal is latent
everywhere today; when one does, it gets a named error instead of a wrong URL,
and porting the fn is then a scoped, gated piece of work.

The retry's SERIALIZATION is not a PHP behaviour and is not optional here.
PHP's manual door was implicitly single-operator; the TS scheduler runs
`DEDALO_DIFFUSION_MAX_RUNNERS` runners concurrently (2 by default) and
`retryPendingDiffusion` SELECTs up to 100 pending rows with no claim and no
lock, so two publish jobs starting together would drain the same rows in
parallel — duplicate delete propagation to the target and duplicate
`jsonb_set` UPDATEs. The whole retry therefore runs under a session-level
Postgres advisory lock taken on a RESERVED connection (`pg_try_advisory_lock`,
key 17581758); a runner that does not win it simply does not retry that pass.

## Gate reconciliation

- `test/unit/diffusion_compile_degrade_native.test.ts` — the whole contract:
  degradation is field-local, reported, and topology-preserving (the mht2
  `rsc1194` case asserts the leaf columns AND the `'Historia, '` merge bytes),
  structural failures stay fatal, an unported fn throws on an empty slice,
  media options select the tier (from the model spec, not a hardcoded install
  default) and are refused only when truthy, and the runner seeds the report,
  routes both retry buckets and single-flights the retry.
- `test/unit/diffusion_plan_compile.test.ts` — unchanged and still valid: an
  element either compiles with `errors: []` or fails with named causes. A
  degraded element now takes the first branch, which is the point.
- **No re-harvest.** The frozen oracle store holds READ-path fixtures; the
  diffusion run report is not among them, and the old-engine SSE transcripts
  assert the frame SHAPE (`errors` has always been an array on the final
  chunk), not its emptiness.

## Addendum 2026-11-12 — `get_geolocation_data` and `map_target_section_tipo` ported (T1-5)

- **Census correction (item 2):** `map_target_section_tipo` was NOT latent. The default
  domain (`dd45 'default'`, the `DEDALO_DIFFUSION_DOMAIN` default) carries element `oh63`,
  whose database `oh88` publishes table `hierarchy79` (`hierarchy`, section `hierarchy1`)
  holding `hierarchy83`: every install publishing hierarchies got one error per record. The
  2026-08-09 census looked at five non-default databases only.
- **Both fns now resolve.** `map_target_section_tipo`: see
  [WC-2026-11-12-diffusion-map-target-section-tipo](WC-2026-11-12-diffusion-map-target-section-tipo.md).
  `get_geolocation_data` RESTORES PHP parity (`build_geolocation_data(false)`: the paired
  geolocation's layers, features flattened to `{type, lon, lat}`, no point fallback) and
  needs no licence. Owner question T1-5 §7 (non-Point geometries publish `lon` = the
  coordinates' first member, `lat` = the second, as PHP did) is OPEN; parity is what ships.
- The "unported fn throws on an empty slice" gate now uses a synthetic fn name.
