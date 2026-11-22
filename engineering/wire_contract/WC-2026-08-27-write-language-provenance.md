# WC-2026-08-27-write-language-provenance — the write language is the request's, and an undeclared one is refused

- **Date:** 2026-08-27 (remediation item P0-7 of the 2026-08-26 deep audit).
  Closes DATA-20, DATA-23, DATA-24, DATA-25 and DATA-01 **for two of its three
  doors**. The third, `tools/tool_update_cache`, is not in this change's edit
  scope: it still buckets lang-less items and an empty component under
  `config.menu.dataLang`. It is enumerated as OPEN in the widened
  `module_state_tripwire` census, so it cannot be forgotten and cannot spread.
- **Decision:** — (DEC-12 gates shipped with it:
  `test/unit/write_lang_provenance_native.test.ts`,
  `test/unit/bulk_process_id_tripwire.test.ts`, and the widened
  `config.menu` lang census in `test/unit/module_state_tripwire.test.ts`.)

### Shape before (PHP)

`DEDALO_DATA_LANG` was a per-REQUEST constant in PHP: `common::get_ar_all_langs`
and the importer alike read a value the bootstrap had already resolved from the
user's session (request > session > install default). So "the importer uses
`DEDALO_DATA_LANG`" meant "the importer uses the operator's current data
language". Nothing validated the code against the install's language set — a
gap the retired engine shared — and there was no MCP/agent surface at all.

### Shape after (TS)

**One law, at the `saveComponentData` chokepoint — and its SCOPE is that
chokepoint.** It governs every SAVE door (the client API, the MCP tools, the
agent change-plan, every import). It does NOT govern the two Time Machine write
doors: `apply_value` and `bulk_revert_process` deliberately bypass
`saveComponentData` and write matrix data directly (`restore_common.ts` — only
the direct path can thread a bulk id and replay a snapshot without the save
pipeline's defaults firing), so a RESTORE can still land any language its audit
row holds, including one this install has stopped declaring. That is coherent
with the round-trip allowance below (a restore re-writes bytes the corpus already
held) and it is not gated here; naming it is the difference between a scope and
a claim.

After the alias hop (so the question is asked about the tipo the write will
actually land on) and before any other ontology read, before this door opens its
transaction, the request's `lang` is checked against the languages this
installation declares:

```
DEDALO_PROJECTS_DEFAULT_LANGS  ∪  {DEDALO_DATA_LANG_DEFAULT}
                               ∪  every member of an equivalence class one of
                                  those belongs to (lg-cat ≡ lg-vlca)
                               ∪  {lg-nolan}
```

**That is exactly the READ-REACHABLE set** — the codes the data fallback chain
(`resolve/component_data.ts`: requested lang → equivalents →
`DEDALO_DATA_LANG_DEFAULT` → `lg-nolan` → `DEDALO_PROJECTS_DEFAULT_LANGS`) can
resolve. It is built in `src/config/data_langs.ts` + `src/config/config.ts`
(`INSTALLED_DATA_LANGS`), next to the keys it derives from.

**`DEDALO_DATA_LANG` is NOT a member, and cannot become one**: it is not an input
to the builder. It is the MENU's current data language, not a read-chain
candidate, so admitting a write in it would put bytes in a slice no read
resolves — the same silent loss through the other door. The write outage it was
briefly seeded against (it is what a door outside any request scope, and a
session that has chosen no language, writes in) is closed at the source instead:

- `currentDataLang()` falls back OUTSIDE a request scope to
  `config.lang.dataLangDefault`, the read chain's first candidate — never to the
  menu language (`src/core/resolve/request_lang.ts`);
- `config.menu.dataLang` is RESOLVED against the declared set at boot
  (`resolveCurrentDataLang`): a `DEDALO_DATA_LANG` naming a language the install
  does not declare is reported at boot, with the fix that recovers the data
  (add it to `DEDALO_PROJECTS_DEFAULT_LANGS`), and overruled by
  `DEDALO_DATA_LANG_DEFAULT`. It reports and does not throw because a fresh box
  is exactly that shape — install mode boots on sentinels where the project
  languages are `['lg-eng']` and `DATA_LANG` holds its catalog default `lg-spa`
  — so a boot refusal would refuse every new installation.

So every language the engine can pick on its own behalf is already a member, no
engine write is ever refused, and nothing lands where nothing reads.

**The builder's boot assertion is the one that can fire**:
`DEDALO_DATA_LANG_DEFAULT` must NAME ONE REAL LANGUAGE (`lg-xxx`; `all` is a
stored-value sentinel, not a language), checked BEFORE it is seeded into the set.
The previous version seeded both engine defaults and then asked whether the set
contained them, so it could only fail on the empty string — an assertion that
could not fire is not an assertion (2026-08-27 review).

An undeclared code THROWS the new registered error `record.lang_not_installed`
(category `caller`, HTTP 400, disclosure `public`, `details.lang`, label
`error_record_lang_not_installed`). **BEHAVIOUR CHANGE A READER MUST NOT
DISCOVER BY SURPRISE: this is the ONE save refusal that throws where every other
returns `ok:false`.** It is a throw because every bulk door folds an `ok:false`
into a per-field "IGNORED" line and keeps going — a whole run in a phantom
language would become a report nobody reads.

**The law governs an OPERATOR-CHOSEN write language, never a ROUND TRIP.** Several
doors choose no language: they forward the lang of a slice they just READ, to
write it back — `tool_update_cache`'s regenerate re-saves each stored lang group,
`component_text_area`'s `tag_delete` removes a tag from the exact stored slice it
was found in, `tool_tc` rewrites the time codes of the component being edited,
`tool_import_files` groups the entries the client shipped by the lang each
carries. Refusing those refuses a re-save of bytes ALREADY IN THE CORPUS, i.e.
ordinary maintenance of a record whose language the install has since stopped
declaring. So an undeclared language is admitted when the STORED component
already carries an item in it — and that is VERIFIED, never declared: the engine
reads the slice its own write is about to land on
(`storedSliceCarriesLang`, one unlocked read on the refusal path only). No caller
can claim the exemption.

**Stated exactly, because an earlier version of this entry overstated it: the
allowance is PER LANG SLICE, not per bytes.** The question asked is "does this
component of this record already hold an item in this language" — nothing
compares the incoming values with the stored ones. Once such a slice exists,
ARBITRARY NEW CONTENT may be written into THAT slice of THAT component,
including a wholesale `set_data` replace and content the record never held. What
it can never do is CREATE a slice in a language the component does not already
carry: the question is asked per component tipo (not per record) and AFTER the
alias hop (so it is asked about the tipo the write really lands on). No new
unreachable language appears anywhere — which is the property the law protects.
Both axes are gated behaviourally (a sibling component of the SAME record still
refuses the language; an alias door is judged on its target's stored slice).

`DEDALO_APPLICATION_LANGS` is deliberately NOT in the set: a UI language is not a
data language, and the read-path fallback chain
(`resolve/component_data.ts` ALL_LANGS) iterates the PROJECT languages, so a
slice stored under a UI-only code is one no read ever reaches through a language
the install offers.

**The declared escape** is `SaveRequest.langMigrationReason` — a non-empty
sentence that lets ONE save write an undeclared language and is logged with the
language, the record and the reason. It is NOT a wire field: no rqo, no MCP
schema and no tool option carries it, so no remote caller and no agent can reach
it. Only an in-repo server-side caller that owns a language migration may set
it, and it must say why. Today nobody does, and the gate freezes that at zero.
The non-urgent escape is configuration: a language an install is ADDING belongs
in `DEDALO_PROJECTS_DEFAULT_LANGS`, which is what the gate reads.

**The doors now resolve the request's language, not the process's.** These
changed what they write:

| Door | Before | After |
|---|---|---|
| `tools/tool_import_dedalo_csv` `resolveMappedColumns` | `translatable ? config.menu.dataLang : 'lg-nolan'` | `translatable ? currentDataLang() : 'lg-nolan'` |
| `src/core/tools/import_execute` (MARC21 / Zotero / RDF) | same static read | `currentDataLang()`, resolved once per run |
| `src/ai/mcp/tools/fields_write` `set_field` | `input.lang ?? 'lg-eng'` | `input.lang ?? currentDataLang()` |
| `src/ai/mcp/tools/records_write` `save_component` | `input.lang ?? 'lg-nolan'` | `input.lang ?? currentDataLang()` when the component is translatable; `lg-nolan` otherwise |

`currentDataLang()` survives into the background job an import runs in —
`mediaJobs.submit` exits only the transaction stores — so a backgrounded run
keeps the session's language.

**The MCP schema descriptions changed with the defaults**: `lang` on
`dedalo_set_field` and on the save tool now document "the session's data
language" instead of `lg-eng` / `lg-nolan`. The FIELD is unchanged (optional
string); only the documented default and the value an omission resolves to.

**`ImportReport` gains `bulkProcessId: number | null`** (`src/core/tools/import_execute.ts`).
The shared MARC21/Zotero/RDF executor now mints a dd800 bulk-process record
before any data row is touched, wraps each record in its own transaction, and
stamps every Time Machine row with the run id — the three properties the CSV door
already had. A failed dd800 mint REFUSES the run, and the mint is ATOMIC (the row
and its label/file are one transaction), so a failed label leaves no orphan
process record behind. `null` means the run was EMPTY: with no mapped records
nothing is written, and a dd800 minted for that would file an event that never
happened in the operator's Processes list — every caller can reach the executor
with an empty set (a MARC21 batch whose files all failed to parse, an RDF export
with no subjects). Neither live caller reads the field.

### Reason

The write is lang-SLICED: `set_data` replaces exactly one language's items. So a
door writing in the process-wide install default did not merely mislabel the
value — it REPLACED a language the operator was not editing, and an empty cell
CLEARED it, with `ok:true` returned. On a multilingual install with the operator
working in English, a CSV of English values landed on (and its empty cells wiped)
the curated Spanish slice. Silent loss of curated heritage data outranks
everything else this engine is asked to rank.

The undeclared-language half is the same loss through the other door: a
`lg-xxx` slice was stored verbatim and never served again, not even as fallback,
and nothing told anybody.

The agent doors were the same defect pointing elsewhere: `set_field` attached
every unlanged write to `lg-eng` and its own read-back defaulted `lg-eng` too, so
the wrong-language attach was self-consistent and invisible to the agent that
made it; the save door defaulted `lg-nolan`, which a translatable component
renders only as a marked fallback, in every language, forever.

### Gate reconciliation

- `write_lang_provenance_native` — census (TOTAL, derived: every caller of
  `saveComponentData` outside `src/core/section/`, each declaring where its
  language comes from; a door with two real sources declares both, joined with
  `+`), the behavioural provenance of FOUR doors under a session language ≠ the
  install default — including the CSV door end to end, through its own
  `import_files` handler on a staged file — the declared set built from a config
  whose keys disagree, the set the chokepoint actually consults rebuilt from the
  live config keys, the boot assertion tripped by four constructed values, the
  round trip on all three of its axes (per slice / per record / per component)
  plus the alias door, read-REACHABILITY measured (declared bytes are served to
  every declared language, the escaped slice to none of them), the refusal +
  escape + its pre-flight position, and the deferred post-save cache clear.
  37 cases, all green, measured 2026-08-27 on `dedalo_v7_mht_test`.
- `bulk_process_id_tripwire` — census (TOTAL, derived: every file that mints a
  dd800 record, each declaring its posture on a failed mint), the TM rows
  measured, the failed-mint refusal, and the per-record rollback.
- `module_state_tripwire` — the S2-11 module-binding rule is widened into a
  per-file census of EVERY `config.menu.dataLang` / `config.menu.applicationLang`
  read outside `src/config/`, in any position, with a reason per entry.

**No parity fixture is affected.** The frozen store holds READ interactions; no
fixture exercises a save, and no fixture's request carries a language outside its
install's set. **Re-harvest: NO — impossible by definition.**

## Addendum 2026-08-27 — the review closures (same day, before the batch landed)

Two adversarial reviewers and one joint reviewer read the landed work. What
changed in the law and in the executor, beyond the corrections already folded
into the sections above:

- **The set omitted `DEDALO_DATA_LANG`** — BLOCKING. On an install where the two
  data-language keys disagree, the chokepoint refused every write in the language
  the engine itself treats as its operational default (it is the ALS backstop for
  every door that never opened a request-lang scope). *(SUPERSEDED the same day
  by the round below: seeding the key fixed the outage by admitting a language no
  read reaches. The outage is now closed at the source instead.)*
- **The chokepoint refused to re-save bytes already in the corpus** — BLOCKING.
  See "the law governs an OPERATOR-CHOSEN write language" above. The distinction
  is drawn by the engine, not by the caller.
- **The dd800 mint is atomic**, and an EMPTY run mints nothing.
- **The census declared `import_csv_execute.ts` as `lang: caller`** and
  `import_execute.ts` as `lang: request`; both also save through
  `groupItemsByLang`, where an item's own lang wins over the column/run language.
  They now declare `caller+items` / `request+items`, and a gate case proves the
  composite is a fact about `groupItemsByLang`, not an opinion.

### The behaviour change that is INTENDED: an observer failure now rolls the record back

With the new per-record transaction, an observer propagation failure during a
MARC21/Zotero/RDF import is RETHROWN (`observers.ts` B6: `propagateToObservers`
swallows only when no ambient transaction can be poisoned) and rolls that record
back; it was swallowed per record before. **That is right, and it is not really a
choice:** inside a transaction the failed statement has ALREADY aborted it, so
swallowing could only hide the cause and hand the record's remaining component
saves a poisoned transaction whose every statement fails with "current
transaction is aborted" — pointing the operator at a phantom bug. And the mirror
an observer maintains is DERIVED data whose whole contract is that it equals its
source: committing the source while the mirror silently fails is the
stale-forever divergence class this engine ranks above throughput. The blast
radius is bounded by design — the record is reported in `failed[]` with the real
message, the run continues, and the source bytes were never written, so the
operator can retry. The CSV door has had exactly this posture since it wrapped
its rows; the two importers now agree with it instead of differing.

### The primary site is no longer gated by a string match

The CSV door (DATA-01's primary site) was pinned only by `expect(source).toContain(…)`
on one line, because `resolveMappedColumns` is module-private. It now also has a
BEHAVIOURAL case: the gate stages a real `;`-delimited CSV in the door's own
import directory, calls the real `import_files` handler inside
`runWithRequestLangs({dataLang: <session lang ≠ install default>})`, and asserts
the stored slice's lang. Mutation-measured: reverting that one line to
`config.menu.dataLang` turns the behavioural case red, not only the textual one.
The textual case is KEPT — it names the defect at the line, which a failing
end-to-end case does not.

### The refusal's PRE-FLIGHT position is gated, two ways — on the door that owns its transaction

"The record stayed empty" cannot tell a pre-flight refusal from a rollback, so
the gate asserts (a) that a refused save opens NO transaction at all —
`withTransaction` is counted around a refused call and an accepted one, so the
zero is measured against a one on the same path — and (b) that the refusal
answers while ANOTHER connection holds the record's row lock, which any save that
reached the write body would have blocked on.

**Both statements are about the door that OWNS its transaction** (the interactive
path, and every door that calls `saveComponentData` with none open). A caller
that ALREADY holds one — the per-record wrap in `import_execute`, the per-row
wrap in `import_csv_execute` — is a different story: `withTransaction` JOINS an
ambient transaction, so the three checks run inside the caller's, the round-trip
read sees the caller's uncommitted rows (correct: those are the bytes the write
would land on), and a refusal rolls that row's transaction back. That is the
intended behaviour for a row-scoped import, but it is not "before the transaction
opens", and the header at the chokepoint now says so.

**No parity fixture is affected by any of this.**

## Addendum 2 — 2026-08-27, the closing round (the fix that inverted the defect)

A reviewer showed that the previous addendum's fix inverted the problem:
`DEDALO_DATA_LANG` is NOT in the read fallback chain, so seeding it into the
declared set bought the engine a write language **no read will ever reach** — a
silent write-to-nowhere, which is worse than the refusal it replaced. The set is
now the read-reachable set again, and the outage is closed where it originates.
What changed, beyond the corrections already folded into the sections above:

- **The declared set moved to `src/config/`** (`data_langs.ts` builds it,
  `config.ts` publishes `INSTALLED_DATA_LANGS`), next to every other language
  key. `DEDALO_DATA_LANG` is not one of its inputs, so it cannot re-enter the set
  by accident — the shape, not a comment, is what forbids it. The
  `config.menu` lang-read census in `module_state_tripwire` is back BELOW where
  this batch found it: **23 → 24** (the previous round's seeding read) **→ 22**,
  because the chokepoint's read is gone and so is the ALS accessor's DATA half.
- **`currentDataLang()` falls back to `config.lang.dataLangDefault`** outside a
  request scope. The value is unchanged on any install whose two data-language
  keys agree (this one included), which is exactly why the gate pins the CODE
  SHAPE at both lines as well as the value. **BEHAVIOUR CHANGE where they
  differ and both are declared** (e.g. `DEDALO_DATA_LANG=lg-cat` with
  `DEDALO_DATA_LANG_DEFAULT=lg-spa`, both project languages): a door outside any
  request scope — a background job, a boot task, a CLI script — now reads and
  writes in `DEDALO_DATA_LANG_DEFAULT` where it previously used
  `DEDALO_DATA_LANG`. That is the point: with no operator and no session there is
  no "current" language to honour, and the install's DEFAULT data language is the
  only one guaranteed to be a read-chain candidate. A door that must write in a
  particular language passes it explicitly, as the import doors do.
- **What a "third value" install experiences, in full.** Take
  `DEDALO_DATA_LANG=lg-eng` with project languages `["lg-spa","lg-cat"]`. Before
  this batch, every session that had not touched the data-language menu wrote its
  records into an `lg-eng` slice — reachable only by another such session,
  because the menu offers only the project languages and the fallback chain never
  consults `DEDALO_DATA_LANG`; the corpus grew there silently. Now: the boot
  prints one line naming the key, the current data language becomes
  `DEDALO_DATA_LANG_DEFAULT`, new writes land in a language every reader can
  reach, and no write is refused. THE CONSEQUENCE TO SAY OUT LOUD: the existing
  `lg-eng` slices, which fresh sessions could still see, are no longer served to
  anyone — the bytes are intact, the language is not offered. The boot line
  carries the one-line recovery (add the code to
  `DEDALO_PROJECTS_DEFAULT_LANGS`, which puts it in both the declared set and the
  read chain), and the round-trip allowance means maintenance can keep re-saving
  those slices meanwhile. A loud, stopped problem with a stated fix beats a
  silent, growing one: that ranking is the premise, not a preference.
- **The boot gains ONE new refusal**: a `DEDALO_DATA_LANG_DEFAULT` that is not a
  `lg-xxx` code refuses the process at config load, naming the key. Verified
  against the real config loader, not only the unit: `DEDALO_DATA_LANG_DEFAULT=spa`
  refuses; `DEDALO_DATA_LANG=lg-xxx` boots, reports once and resolves to the
  default.
- **`config.menu.dataLang` is resolved against the declared set at boot.** This
  is what keeps the interactive door working on an install whose
  `DEDALO_DATA_LANG` is a third value: dispatch seeds the request-language scope
  with it for every session that has not chosen a language, and the client writes
  it back as the save's `lang`. An out-of-set value is reported at boot (with the
  recovery action) and overruled — never refused at the chokepoint, never stored.
- **The boot assertion can now fire**, and each input that trips it is
  constructed in the gate (`''`, `spa`, `all`, `lg spa`).
- **The gate asserts the CALL SITE, not only the builder**: the module-level set
  the chokepoint consults is rebuilt from the live config keys and compared. A
  correct builder wired to different values is what produced this round.
- **Two ungated widenings are now gated**: the per-COMPONENT axis (an undeclared
  language on one component of a record does not license it on another) and the
  ALIAS door (the round-trip question is asked about the target tipo — moving the
  check above the alias hop is red).
- **The gates fail instead of skipping** when the suite database is unavailable.
  `if (!ready) return;` reports a PASS with zero assertions, so the closure of
  two blocking defects was silently green on a DB-less box. Measured: with the
  setup forced to fail, `write_lang_provenance_native` goes 21 red / 15 pass and
  `bulk_process_id_tripwire` 8 red / 3 pass, instead of all-green.

### The second behaviour change to record: the post-save cache clear is deferred

`saveComponentData` invalidates the security caches after its own
`withTransaction` returns — "post-commit" only while this door OWNS the
transaction. With the executor's new per-record wrap it can now return with an
ambient transaction still OPEN, and clearing a process-wide cache there re-opens
the S1-14 window: a concurrent request repopulates the cache from state that does
not include this write, and the entry is stale from the moment the caller
commits. The clear is therefore queued on `deferPostTransaction` (the house lane
for idempotent cache invalidation, replayed after the transaction settles, on
rollback too); with no ambient transaction it still runs inline, exactly as
before. Gated both ways in `write_lang_provenance_native`.

**No parity fixture is affected by any of this.**


---

## Addendum, 2026-08-31 — the three remaining doors are CLOSED

This entry recorded `tools/tool_update_cache` as out of scope ("it still buckets
lang-less items and an empty component under `config.menu.dataLang`"), and its
door table listed four doors. Three more have since been closed and the ledger
must not go on describing an engine that no longer exists:

| Door | Was | Now |
|---|---|---|
| `tool_update_cache` regenerate default bucket | `config.menu.dataLang` | `currentDataLang()` |
| `duplicate_record` TM audit slice | `config.menu.dataLang` | `currentDataLang()` |
| `tool_posterframe` MediaIdentity lang | `config.menu.dataLang` | `currentDataLang()` |

**WIRE-VISIBLE**: the poster frame one is not only a write language. A
translatable media component's identity carries a LANGUAGE SEGMENT in its file
path, so a frame created for an operator working in `lg-cat` on an install whose
`DEDALO_DATA_LANG` is `lg-spa` is now filed under `lg-cat` — a different URL from
the one the same action produced before. Existing frames are not moved; nothing
re-derives a path for a frame already on disk.

Outside a request scope all three fall back to `DEDALO_DATA_LANG_DEFAULT` per
Addendum 2, which is the point: `menu.dataLang` is a per-user MENU selection and
is not in the data fallback chain, so a background job's write stamped with it
can land in a slice no read resolves.

Gated by the P0-7 census in `test/unit/module_state_tripwire.test.ts`, which now
pins BOTH directions — `config.menu.dataLang` may not come back, AND each door
must still read `currentDataLang()` (a rewrite to `config.lang.dataLangDefault`
reddens it).

## Addendum, 2026-10-05 — the background lang is a PIN, not ALS survival

The original entry credits ALS inheritance for a backgrounded import keeping the
session's language ("`currentDataLang()` survives into the background job …
`mediaJobs.submit` exits only the transaction stores"). The OUTCOME is unchanged;
the MECHANISM is not: inheriting the submitter's scope was an accident of the
runtime (it also handed the job the answered request's context and refusal log).
Since this date the job manager captures the submitter's langs at `submit()` and
pins them, with a job-owned request context (principal snapshot, `null` session,
request id `job:<id>`, own refusal log), around the worker — `JobRunScope` in
`src/core/media/jobs.ts`; rule 3 of `engineering/REQUEST_ISOLATION.md`. A
dispatcher or pool that calls the worker from a foreign scope no longer changes
the write language. Gated by `test/unit/media_jobs_reconcile.test.ts` ("a job
runs under its OWN pinned identity, whatever scope calls its worker" — red with
the pin removed). Wire-visible: none.

## Addendum, 2026-11-22 — the census became a law (T2 B10)

The P0-7 per-file `config.menu` census in `module_state_tripwire` named above
(both "Gated by" lines) is RETIRED into `test/unit/request_lang_law_tripwire.test.ts`:
no `config.menu` lang read outside `src/config/` and the request-lang module, and
no language-literal default, zero allowlist — the remaining install-language reads
(the dispatch seed, the scheduler and RAG scopes, a test-data generator, the
installer) are named exemptions next to the code. The DATA-01 positive pins (each
door reads `currentDataLang()`) stay in `module_state_tripwire`. Wire-visible: none.
