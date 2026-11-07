# WC-2026-08-28-idempotency-key — a request the transport may resend carries a key, and the server executes it once

- **Date:** 2026-08-28 (remediation item P0-10 of the 2026-08-26 deep audit).
  Closes CLI-01 (S1, CONFIRMED).
- **Decision:** — (DEC-12 gate shipped with it:
  `test/unit/client_idempotency_tripwire.test.ts`.)

### Shape before (PHP)

There was no request-level de-duplication in PHP either, and no key on the wire.
What PHP had that reads like one and is not: `prevent_lock`, which gated
`session_write_close()` before long queries — a PHP-session-runtime concern with
no Bun equivalent. It was carried into the TS rqo schema as an accepted field
with nothing behind it, and its name has misled every reader since.

### Shape after (TS)

**ONE NEW WIRE FIELD on the rqo: `idempotency_key`** — an optional string,
`^[A-Za-z0-9_-]{16,128}$`, minted by the browser transport, ONE PER LOGICAL CALL.
It names an operation, not a request: every retry of that call ships the same
key, in byte-identical bytes, because the transport injects it ONCE before
serialization (`client/dedalo/core/common/js/data_manager.js`,
`execute_request`). The grammar is enforced by the rqo schema, so a malformed key
is one uniform `request.invalid_rqo` at the parse door rather than a field some
paths ignore.

**Who stamps.** Not the call sites — the transport, for every request it may
resend (`retries > 1`) whose body is a plain object. Callers do not opt in and
must not pass a key of their own (a key reused across two different operations
is worse than no key), which the gate asserts across all 246 census sites. A
v4 UUID where `crypto.randomUUID` exists; 16 random bytes as hex where it does
not, because `randomUUID` is a SECURE-CONTEXT api and a museum install served
over plain http has none — there the property is `undefined` and calling it
would have thrown inside the transport.

**What the server does with it** — `src/core/api/dispatch.ts`, Gate 4, after
auth/CSRF and before the handler:

- the first request under a key RESERVES the key synchronously (no `await`
  between the lookup and the insert, which is what makes the reservation atomic
  in a single-threaded runtime) and executes;
- a TWIN arriving while the leader still runs does not execute: it awaits the
  leader's own promise, BOUNDED (see "the twin never waits forever" below);
- a twin arriving after the leader finished is served the STORED answer —
  the original status, the original body, plus one extension key
  `idempotent_replay: true` and this request's own fresh `csrf_token`. The
  `request_id` in a replay is the ORIGINAL request's, because it IS the original
  answer;
- a key re-used for a DIFFERENT request (the fingerprint is a sha256 of the rqo
  minus its key and its csrf token) is refused with the new
  `idempotency.key_reused` (409). Silently swallowing the second operation and
  returning the first one's answer would be data loss wearing a success;
- an answer too large to store (over 512 KB serialized) is not stored, and its
  replay is refused with the new `idempotency.replay_unavailable` (409) — the
  entry STAYS, because forgetting it would re-admit the duplicate execution;
- a leader that THREW keeps its reservation, and later twins are refused with
  the new `idempotency.outcome_unknown` (409) — the rule below.

**FOUR new registered error codes**, all category `conflict`/409 and none of
them `retryable`: `idempotency.key_reused`, `idempotency.replay_unavailable`,
`idempotency.outcome_unknown`, `idempotency.in_progress`, with labels
`error_idempotency_*` in `src/core/labels/master.json`.

`idempotency.outcome_unknown` carries `details_keys`
`['action', 'original_request_id', 'original_error_code']` and
`idempotency.in_progress` carries `['action']`, so the refusal NAMES WHAT TO
CHECK on the wire and not only in the server log: which action, which
`request_id` the ambiguous attempt carried (findable in the access log), and what
it failed with. All three are this server's own identifiers, already disclosed in
every envelope; the labels interpolate them
(`error_registry_native` requires label placeholders ≡ `details_keys`).

### THE AMBIGUOUS-OUTCOME RULE (the correction that matters)

The first draft of this change asserted, in the code and in this entry, that "a
THROWN handler committed nothing — withTransaction rolled its work back — so a
later retry MUST execute". **That is false**, and shipping it would have
reintroduced the very defect through the error path, on the exact action the
finding names. Verified in the tree:

- `src/core/section/record/duplicate_record.ts` opens **no transaction at all**.
  The clone COMMITS at `insertMatrixRecordWithCounter` (a single autocommit
  statement), and the frame-target re-mints, the media file copies, the two Time
  Machine rows per component, the observer cascade and `fireSaveEvent` all run
  outside any transaction around it.
- `dd_core_api:create` commits its row and THEN awaits `fireSaveEvent` and
  `logActivity`, outside any transaction.

So a throw AFTER a commit is the ordinary case, not the exotic one. The rule
this change ships instead:

> **ON AN AMBIGUOUS OUTCOME, DO NOT RE-EXECUTE.**

- A leader that throws **keeps** its reservation, marked `ambiguous` with the
  original failure's code and its `request_id`.
- The leader itself still receives its own real error — that is the truth about
  its own attempt.
- Every later request under that key is refused with
  `idempotency.outcome_unknown` (409). Its wire `details` name the action, the
  original `request_id` and the original error code, and its label interpolates
  all three and tells the operator to reload and check the record before acting.
  Not `retryable`: no amount of retrying can turn an unknown outcome into a
  known one.
- **Nothing lawful is locked out.** The key names ONE LOGICAL OPERATION and is
  minted per call, so a curator's own deliberate re-click is a new key and a new
  execution; only the transport's automatic resend of the one ambiguous attempt
  is refused. The reservation expires with the TTL in any case.

A duplicate heritage record created silently is worse than an error a curator
can act on. That ordering is the project premise, not a preference.

**`duplicate_record.ts` was NOT wrapped in a transaction in this change**, and
its header now says why in full. A naive wrap introduces a worse defect than it
closes: the section_id comes from a ROW in `matrix_counter`
(`ON CONFLICT (tipo) DO UPDATE SET value = value + 1`), not from a sequence, so a
ROLLBACK returns the counter and hands the SAME id to the next duplicate — while
the media files already copied under that id (`media/path.ts`:
`{component_tipo}_{section_tipo}_{section_id}`) are not rolled back and would be
adopted by that next record. Silent misattribution of a photograph, which nothing
detects. The correct form is a SPLIT — a transaction over the re-mints, the
insert, the Time Machine rows and the in-transaction observer writes, with the
media copies and `fireSaveEvent` strictly AFTER the commit — and it is a
restructure of the engine's most delicate write path that needs its own gate and
its own change. It would also change the observer contract: cascade hops would
defer to the commit-only lane (`emitCascadeHop`, designed for exactly that, since
`runObserverCascadeHop` refuses an ambient transaction — B6), but
`propagateToObservers` RETHROWS inside an ambient transaction where it swallows
loudly outside one, so an observer failure that today leaves a good duplicate
would abort the duplicate instead. **And it would not remove the need for the
ambiguous-outcome rule**, which stands as long as any committed work can be
followed by a throw.

**DEFENCE IN DEPTH (P0-10 direction (b)), applied at the chokepoint instead of at
~130 call sites: retrying is CONDITIONAL on being stamped.** A body the transport
could not stamp (a caller that pre-serialized its own JSON string) is sent AT
MOST ONCE. A request with NO body at all is exempt — a bodyless GET of a static
asset duplicates nothing on the server, and killing its retry would break a
legitimate recovery on a flaky link for no gain.

**`prevent_lock` is now held inert MECHANICALLY.** The declaration stays (about
51 client files (114 occurrences, measured 2026-08-28) and one MCP READ tool
still send it; removing it would make
`.passthrough()` absorb the field silently, which is worse than declaring it),
but the gate asserts it has ZERO READERS anywhere in `src/` and `tools/` and
enumerates the three files that so much as name it. The two INTERNAL senders —
`src/ai/mcp/tools/records_read.ts` and `src/core/ontology/data_io_import.ts` —
set the flag on an rqo they build in-process. ONE OF THEM DOES CROSS THE WIRE:
`src/core/ontology/data_io_import.ts` POSTs that rqo to a REMOTE master
(`checkRemoteServer`, a JSON body over fetch), so the field travels between
installations even though nothing reads it at either end. The other
(`src/ai/mcp/tools/records_read.ts`) is in-process only. Both are inert, and
which nothing reads: pure cargo-cult, scheduled for deletion, held in the
shrink-only enumeration until then so their removal is a two-line diff and a
third sender is red on arrival.

### THE DEDUP WINDOW, stated in full because it is not zero

The ledger is IN-PROCESS: a `Map` in `dispatch.ts`, bounded four ways — 15
minutes of age (the whole measured client retry span is 78 s), a PER-PRINCIPAL
cap of 100 entries / 1 MB, and a process-wide backstop of 5 000 entries / 32 MB —
with eviction oldest-first and an in-flight entry never evicted. It is not a
table, and that is a limitation, not a preference: the design with NO residual
window at all writes the key row inside the WRITE's own transaction, so record
and key commit atomically — and that transaction is opened downstream inside the
handler, when it is opened at all.

- **Recorded BEFORE the handler runs, not after.** Recording after the commit
  would leave open exactly the window the defect exploits (a retry landing
  between the commit and the record).
- **The TTL is enforced ON THE READ PATH.** The first draft swept only from the
  leader's success path, so `withIdempotency` replayed on a bare `ledger.get`
  with no age check — on a ledger that had stopped receiving successful writes,
  the documented fifteen-minute window was in fact unbounded. The sweep now runs
  on every ledgered request's read path and on every leader completion, success
  and failure alike, and the read path re-checks the age before it replays.
- **The twin wait is bounded** (`IDEMPOTENCY_TWIN_WAIT_MS`, 10 s). `await
  entry.pending` had no deadline, so a leader blocked on a Postgres row lock
  pinned one socket per twin indefinitely — and this engine holds owner row locks
  from read to COMMIT on the delete path, which is exactly that shape. Past the
  bound the twin is refused with `idempotency.in_progress` (409) and NOT
  re-executed: a leader still running is the most ambiguous outcome there is. The
  leader keeps running and keeps its reservation, so the next retry gets either
  its answer or its `outcome_unknown`.
- **Residual (a):** a process restart between the commit and the retry empties
  the ledger, so that one retry re-executes.
- **Residual (b):** eviction. The per-principal caps mean one operator cannot
  evict another operator's entries **by their own volume** — the property the
  first draft's header claimed while only global caps existed, which was false:
  with global bounds alone, any authenticated user could evict any other's. What
  remains true is that the process-wide backstop is NOT per-principal, so tens of
  simultaneously active operators together can reach it, and there eviction is
  oldest-first across principals. Stated here, in the code, and in the gate.
- **Residual (c):** a multi-process deployment would hold one ledger per process.
  This engine is single-process today (one Bun process on one socket).
- **Not covered by design, enumerated:** UNAUTHENTICATED requests are never
  ledgered — there is no principal to scope a bound to. The pre-auth actions are
  `login`, `change_lang` and the two password-reset doors; none touches the
  catalogue, and up to five reset mails is the residue.
- **NOT BEHIND THIS GATE AT ALL:** the **multipart upload branch** in
  `src/server.ts` answers before `dispatchRqo`, so a chunk POST never reaches
  Gate 4 — and it is the receiver of the one client transport that already
  retries by itself (`upload_transport.js`, `max_retry` 3 per chunk). What bounds
  it there is its own per-transfer identity: `transfer_id` is minted ONCE per
  transfer and every retried chunk carries the same one, so a resent chunk lands
  in the same staging artifact instead of a second one. The step that turns
  staged chunks into a record, `join_chunked_files_uploaded` (`retries:5`), comes
  back through the JSON door and IS stamped and gated. The gate pins the shape of
  that branch in `server.ts` so this statement cannot rot into a false one.

None of the residuals is the measured defect. That defect is one client, on one
process, within seconds — and it is closed completely.

### Reason

`fetch_api` classifies its OWN AbortController firing as `client.timeout`, which
is retryable, and re-sends the identical POST. The abort is CLIENT-SIDE ONLY:
`src/server.ts` has no `request.signal` / `AbortSignal` handling anywhere (its
four `signal` hits are SIGTERM shutdown), so the aborted attempt's handler runs
to completion and COMMITS. The resend was therefore a SECOND operation.

Measured against the real transport with the shipped defaults: ONE call produced
5 byte-identical POSTs over 47.5 s, and 78 s with `/health` answering — so the
mid-attempt busy-server probe is not a mitigation, it is a window widener.

On a throttled link one click on "New record" produced up to five blank records
in the catalogue and one click on "Duplicate" up to five clones of a heritage
record. Nothing refused or serialised the resend: there is no natural-key
uniqueness on a create, `section/locks.ts` is a per-user lock on an EXISTING
record (a create has no key to lock, and the same user's retry re-acquires the
lock it already holds), and `prevent_lock` was never a concurrency control.
Silent duplication of heritage records outranks everything else this engine is
asked to rank.

### Gate reconciliation

`test/unit/client_idempotency_tripwire.test.ts` (DB tier — blocks A–D are
DB-free; E, F and G drive the real create door). Measured on the final tree
2026-08-28: **41 pass / 0 fail**, 11.0 s.

- **A** — `ACTION_IDEMPOTENCY` is TOTAL over `listRegisteredActions()` (90 pairs);
  its `idempotent` half is frozen as a CEILING that may only shrink, because
  declaring an action idempotent is what REMOVES protection from it.
- **B** — the key's grammar, asserted on both sides of the wire; `prevent_lock`
  reader-count zero with the three mentioning files enumerated and settled.
- **C** — the client census, TOTAL over `client/` and `tools/**/js`: 246 call
  sites, 228 through the retrying transport, 18 through the two streaming doors.
  No call site mints its own key. The ENUMERATED, shrink-only exemption list now
  covers **four transports the first draft's detector could not see** — a raw
  `fetch()` or `new XMLHttpRequest` aimed at the API escaped a scan that looked
  only for `data_manager.request` and `api_transport.js` imports:
  - `tools/tool_assistant/js/agent_stream.js` → `dd_mcp_api:agent_chat_stream`
    (one raw `fetch(data_manager.url)` opening an SSE turn, no retry loop);
  - `tools/tool_sitebuilder/js/builder_stream.js` → `dd_tools_api:tool_request`
    (`tool_sitebuilder` / `session_stream`, same shape);
  - `tools/tool_transcription/js/tool_transcription.js` →
    `dd_tools_api:tool_request` (`delete_transcribable_audio_file`, a `keepalive`
    unload fetch; every `retries` literal in that file is 1);
  - `client/dedalo/core/services/service_upload/js/upload_transport.js` → the
    MULTIPART branch (see the residual above).

  Three of those four send `mutating` actions, so each exemption now declares a
  **basis** — `idempotent-actions`, `single-shot`, `not-gated-here`, `stamper`,
  `harness` — and the gate checks the basis: idempotent actions are verified
  against the map, and a `single-shot` file is verified to ask no transport for a
  resend (no `retries` literal above 1, no `api_transport.js` import).
- **D** — the REAL `data_manager.js` is imported (its own bytes; only its four
  leaf modules are stubbed) and driven against a stalling server: five attempts,
  ONE key, byte-identical bodies; a `retries:1` call carries none; two calls
  never share a key and the caller's body object is not mutated; an unstampable
  body is sent once; a bodyless GET still retries.
- **E** — the real `dd_core_api:create` door on the generic `test` TLD, with the
  POSITIVE CONTROLS that make the rest mean anything (no key ⇒ two records; two
  different keys ⇒ two records), the concurrent pair, the key-reuse refusal, and
  **the ambiguous-outcome cases**: a probe that runs the real create door (which
  commits) and then throws is NOT re-executed on the retry (`outcome_unknown`,
  record count unchanged); a NEW key for the same work still executes; and a
  CONCURRENT twin of an ambiguous leader is refused while the leader itself gets
  its own real error. The refusal's wire `details` are asserted to point at the
  ambiguous attempt's own `request_id`.
- **F** — every bound TRIPPED, not asserted: age eviction from the sweeper AND on
  the read path with the clock moved past the TTL; the per-principal entry and
  byte caps driven through a real leader completion with a bystander principal
  that must survive; the process-wide backstop; byte accounting returning to
  zero; and an in-flight entry that eviction must not take.
- **G** — the twin wait, twice: the mechanism at a millisecond deadline, and the
  WIRING (a real twin of a really stuck leader, refused at the real 10 s bound
  with `idempotency.in_progress`, the leader finishing untouched afterwards).

**Mutation-measured on the final tree, 2026-08-28** — each guard was disabled and
the reds counted:

| mutation | reds |
|---|---|
| leader's catch deletes the reservation again (the first draft) | 1 (`AMBIGUOUS OUTCOME…`) |
| read path replays without the age check | 1 (`TTL: the READ path…`) |
| twin awaits `entry.pending` unbounded | 1 (`WIRING…`, by 60 s timeout) |
| `sweepPrincipalEntries` not called | 2 (both `PER PRINCIPAL…`) |
| `sweepPrincipalEntries` ignores `principalKey` (global) | 2 (both `PER PRINCIPAL…`) |
| raw `fetch`/XHR legs removed from the census detector | 2 (both block-C census cases) |

**Suite regression, measured on the final tree**: `bun test test/unit` →
**8660 pass / 9 fail / 719 files**. The nine reds are the machine's PRE-EXISTING
set, verified by re-running the same command with the four touched `src/` files
reverted to `HEAD`: the identical nine names, no more and no fewer. `bunx tsc
--noEmit`: zero errors. `bun run lint`: the two findings this change introduced
(one unused parameter, one format) are fixed; the remainder are pre-existing and
untouched.

One shape note the ratchet forced, recorded because the reason is not obvious:
`sweepPrincipalEntries` first landed as a single scan-and-evict function at
cyclomatic 7, which moved `crap_complexity_ratchet`'s frozen census from 695 to
696. It is split into `principalLedgerEntries` (the scan) and the sweep (the
eviction rule); the census is back at 695 and the baseline is untouched — no
number was raised to get green.

`test/unit/module_state_tripwire.test.ts`: **13 pass / 0 fail** on the final tree
(it was 11/2 before the two allowlist rows were added). Both rows carry a
lifecycle that is TRUE of this tree — the earlier draft's "swept on every insert"
was not.

**No parity fixture is affected.** The frozen store holds READ interactions, and
`read`/`read_raw`/`count`/`start` are classified idempotent and never ledgered;
no fixture request carries an `idempotency_key`. **Re-harvest: NO — impossible by
definition.**

### Tripwire registration rows (for the lead — this change does NOT edit them)

`engineering/TRIPWIRES.md`, `scripts/verify.ts` TRIPWIRES and the CI tier scripts
must gain ONE new tripwire; `module_state_tripwire` is already registered
everywhere and only its allowlist changed.

**1. `engineering/TRIPWIRES.md`** — one row, in the file's two-column shape
(`| Tripwire | Invariant |`), appended in the same relative position as the row
added to `scripts/verify.ts`:

```
| test/unit/client_idempotency_tripwire.test.ts | A request the transport may RESEND executes ONCE (CLI-01, WC-2026-08-28-idempotency-key). `ACTION_IDEMPOTENCY` is TOTAL over the action registry and its `idempotent` half is a shrink-only CEILING; the rqo `idempotency_key` grammar is the one the client mints against; `prevent_lock` has ZERO readers in src/+tools/. The client census is TOTAL over `client/` and `tools/**/js` INCLUDING the transports that reach the API without `data_manager.request` — raw `fetch()`, `new XMLHttpRequest`, `sendBeacon`, direct `api_transport.js` — each enumerated with a declared basis the gate checks (idempotent actions / single-shot / not-gated-here), and the ONE door outside the gate (the multipart branch in src/server.ts) has its shape pinned. The real `data_manager.js` stamps once per logical call; the real `dd_core_api:create` door executes once, REFUSES an ambiguous retry (a handler that wrote and then threw is never re-executed), bounds the ledger by age on the read path + per-principal entries/bytes + a process-wide backstop, and bounds a twin's wait on its leader |
```

**2. `scripts/verify.ts`** — add `'test/unit/client_idempotency_tripwire.test.ts'`
to the `TRIPWIRES` array (`ci_workflow_tripwire` asserts the array equals the
index's first column EXACTLY, so both edits must land in the same change).

**3. `scripts/ci/db_tier.sh`** — add
`test/unit/client_idempotency_tripwire.test.ts` to the `DB_TIER_TRIPWIRES` array
(the list is alphabetical; it sorts between `client_libs_tripwire` and
`coex_tag_tripwire` if those are present, otherwise by its own name). Blocks E, F
and G open Postgres and write to `matrix_test` on the suite database, sweeping
what they mint.

**4. `scripts/ci/hermetic.sh` — NO.** The gate must NOT be added to the hermetic
list: it needs a database. If `ci_workflow_tripwire`'s `NOT_HERMETIC` map wants a
written reason, it is "blocks E/F/G drive the real `dd_core_api:create` door on
the suite database".

Runtime to budget: **11.1 s** measured, of which ~10 s is block G's WIRING case
deliberately waiting out the real twin-wait bound on a stuck leader (the only way
to prove the wiring rather than the helper). `db_tier.sh` runs with
`--timeout=30000`; the case declares its own 60 s timeout, so no tier-level
timeout change is needed.

## Addendum 2026-11-06 — a `tool_request` twin of a read-only action re-executes and is never replayed

**Shape after, for one polymorphic door.** `dd_tools_api:tool_request` stays
`mutating` in `ACTION_IDEMPOTENCY` (block A of the gate is untouched, and so is the
`idempotent` ceiling). Gate 4 now refines it **per request** by the NESTED action: a
tool action whose spec declares `readOnly: true`
(`src/core/tools/module.ts`) is not ledgered. A keyed `tool_request` to such an
action therefore carries the key on the wire as before, and the server simply
does not reserve it:

- two requests under one key execute **twice** — a twin is never held, never
  answered with `idempotent_replay: true`, never refused with
  `idempotency.key_reused`;
- a handler that throws leaves **no** `ambiguous` reservation, so any stamped
  resend of a retryable error (`external.http_status`, `external.timeout`, 503
  and 504) receives the action's **real** outcome on every attempt, never
  `idempotency.outcome_unknown`. That masking was the measured defect on the
  acquisition tools, whose `tool_request` actions throw `external.http_status`.
  (The first-party tool client calls a read-only action with `retries: 1` — see
  **Client** below — so the browser transport itself does not resend it; this is
  what every OTHER resender gets.)

The classification is read from the **loaded module's own declaration** for the
exact `(tool, action)` pair; the client cannot claim it (a `read_only` field in
`options` or `source` changes nothing) and the same action name on another tool
does not inherit it. Every doubt stays ledgered: an unknown tool or action, an
`options` that is not an object, a request with `background_running: true` (a job
is a write; the loader also refuses `readOnly` on a `backgroundRunnable` action).
The two reserved framework actions `get_background_job_status` and
`get_background_jobs` classify read-only. Classification precedes the tool-grant
gate and grants nothing — and it is made WITH the caller's identity: it asks the
same grant decision as gates 3+4 (`isToolGranted`) first, and a caller the tool is
not granted to is always ledgered. Without that, the ledger's behaviour on a
resend was an oracle: the second send of one keyed request gave an ungranted caller
`tool.not_authorized` again for a read-only pair, and `idempotency.outcome_unknown`
for any other (an unknown tool or action, a mutating action) — telling them which
tools and actions exist and which declare `readOnly`, the existence leak
`unknownTool` (`tools/dispatch.ts`) refuses. Now an ungranted caller sees one
sequence whatever they name (block H). A classification lookup that throws also
stays ledgered (fail-safe, exercised by block H).

**What makes the claim safe, and what it does not cover.** The dispatcher runs a
read-only handler inside the read-only request scope
(`src/core/security/read_only_scope.ts`): every matrix DML primitive, the item-id
counter writers (`allocateComponentItemId` / `absorbComponentItemIds`, real UPDATEs
of `meta` that a resend would bump again), the activity and update-row writers, the
Time Machine writers and the job manager's `submit` refuse there with
`internal.invariant`, so a wrong declaration fails loudly instead of re-admitting
CLI-01 (one exception: the activity log's only emitter, `logActivity`, swallows every
failure by design, so there the row is dropped and the refusal logged, and the static
walk names the caller). The scope has no exit — a job never inherits it. That is the
ENUMERATED set; the rest of "executing it twice leaves the same
end state" is the tool author's attestation — media files (no single write door),
a directly spawned `psql` child, DML on other stores (stats, locks, queues, the
ontology, the derived search tables) and a streamed response body are NOT policed
by any leg, and every statement of the claim says so. Gates:
`test/unit/tool_read_only_action_tripwire.test.ts` (declaration, static write-door
walk, runtime scope, a queued job freed from inside the scope) and
`test/unit/client_idempotency_tripwire.test.ts` block H (the dispatcher, through the
real `dispatchRqo`).

**Client.** `tool_common.prototype.tool_request` accepts and forwards `retries`,
`timeout` and `busy_notice` to `data_manager.request` — only when the caller gives a
usable one (`retries`: an integer >= 1). A read-only action is never ledgered, so the
transport's own resend of a stalled call re-executes it (up to five upstream calls
per click, where the ledger used to make it one): a tool that declares a read-only
action calls it through `tool_request(` with the literal `retries: 1`, so the
transport sends once and stamps no key. No wire field is added; the client census
(block C) gained the forwarder pin, a `tool_request(` call-site rule (every `retries`
a literal) and the read-only call-site rule, derived from the loaded modules. What
that rule checks is source text, in the tools that declare a read-only action: each
`tool_request(` call is read at depth 0 (its own `action` and `retries`; a nested
option, a shorthand or a spread does not count as a literal), a call of a read-only
action must spell `retries: 1`, an unreadable action must too, and the other
spellings of the door — a hand-built `dd_tools_api` body, `create_source` of a
read-only action, `tool_request` used as a value — are refused in such a tool because
the census cannot follow where they end up. A read-only action requested from another
tool's code or from `client/` by an inline source is not covered.

**Transport fix (same change).** `data_manager.execute_request` decided the
idempotency stamp from the raw `retries > 1` while `fetch_api` clamped
`Math.max(1, retries ?? 5)`: a `retries` of `undefined` or `null` (a key present in
the options overrides the default) was FIVE UNSTAMPED attempts — a write resent blind,
CLI-01 — and `NaN` was none. The count is now normalised once (a finite number is
floored and clamped to >= 1, anything else is the default 5) and both the stamp and
the retry loop read that value. Behaviour for a valid `retries` is unchanged
(block D).

**Gate reconciliation.** No parity gate: the divergence is within the TS engine's own
ledger and adds no response field, no error code and no label.
