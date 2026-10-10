/**
 * Static tripwire for the §4 request-isolation invariant: NO request-carrying
 * mutable state at module scope in a long-lived Bun process.
 *
 * This is the enforcement the invariant lacked (biome only bans `var`; the rule
 * otherwise lived in prose). It is a TRIPWIRE, not a full purity proof: it flags
 * every module-level `let`/`var` against a small allowlist of known
 * request-INDEPENDENT lazy-init/boot caches, so a NEW top-level mutable binding
 * fails the build and forces a decision — either it is request-independent
 * (add it to the allowlist with a one-line justification) or it must be made
 * request-scoped (an AsyncLocalStorage scope, or a cache keyed by full identity
 * incl. user/lang). It also forbids capturing a request-scoped accessor into a
 * module-level binding (the classic bleed shortcut) AND capturing
 * config.menu.applicationLang/dataLang into a module-level binding (the S2-11
 * defect class: freezes the install default where PHP uses the per-request
 * lang). That last rule is WIDENED at the bottom of this file into a full
 * per-file CENSUS of every config.menu lang read outside src/config/, in any
 * position — the 2026-08-26 audit found the write doors reading it from
 * function-local ternaries, which the module-binding regex cannot see (P0-7).
 *
 * CACHE-FACTORY GATE (WS-B, DEC-13 rule 1): a module-level MUTABLE
 * `const … = new Map()/new Set()` cache must be created through
 * ontology/cache_factory.ts (createOntologyCache / createDataCache), which
 * hub/event-registers it BY CONSTRUCTION — the audit showed "modules remember
 * to register" fails in practice (S1-09: ≥16 of ~20 unregistered). Justified
 * non-factory module Maps/Sets live in ALLOWLISTED_MODULE_MAPSET, each entry
 * with a LIFECYCLE justification (who clears it, and when — DEC-12
 * refinement). Declarations typed ReadonlyMap/ReadonlySet are exempt (frozen
 * dispatch/constant tables, not caches). Key correctness (every identity the
 * value depends on is in the key) remains proven behaviorally by
 * concurrency_interleave.test.ts, not statically.
 *
 * MUTATED-CONST GATE (evasion-hole hardening, 2026-07-07): a module-level
 * `const NAME = {…}` / `const NAME: T[] = […]` is just as mutable as a `let` —
 * the audit proved the `let`-only scan blind to it (process_health.ts
 * poisonState, server.ts dbHealth shipped through it). The scan flags a
 * column-0 const OBJECT/ARRAY literal only when the SAME FILE later mutates it
 * (property/index assignment, ++/--, push/pop/shift/unshift/splice/fill/
 * copyWithin, set/add/delete, `delete NAME.x`) — so the many legitimate frozen
 * constant tables stay exempt with zero annotation burden (an unmutated const
 * literal is constant in practice; `as const`/Object.freeze shapes can never
 * be mutated so they never trip). Known request-INDEPENDENT process state
 * lives in ALLOWLISTED_MODULE_CONST with the same justification bar as the
 * `let` list. Module-level `new WeakMap()`/`new WeakSet()` joins the Map/Set
 * factory gate unconditionally (a module WeakMap is always a cache).
 * Residual (accepted) blind spot: mutation via an aliased reference or from
 * ANOTHER file (`import { x } …; x.y = 1`) — cross-file mutation of an
 * imported binding's properties is rare and reviewable.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';

const SRC_DIR = join(import.meta.dir, '..', '..', 'src');

/**
 * Known, reviewed module-level `let` bindings — all request-INDEPENDENT
 * (boot/install-stable lazy caches or one-time init flags; audited safe). Keyed
 * `<path-relative-to-src>:<name>`. Adding a new top-level `let` requires adding
 * it here WITH justification that it carries no request identity.
 */
const ALLOWLISTED_MODULE_LET = new Set<string>([
	// FOUND 2026-08-31 by widening this census to tools/ (P2-20 / GATE-34) — tool
	// SERVER code runs in the same process and handles requests.
	//
	// Keyed on the CONFIGURATION fingerprint, never on request identity: a config
	// module swapped under the process re-proves the pairing rather than
	// inheriting the previous verdict. Cleared by that key changing.
	'tools/tool_sitebuilder/server/daemon_client.ts:provenPairing',
	// The periodic expired-session sweeper's timer handle (SEC-09, 2026-08-28). A
	// process-lifecycle latch of the same family as `shuttingDown` below: it holds a
	// Timeout, is set once at boot and cleared once at shutdown, and no user, session
	// or language can reach it. It exists so a second start() call cannot stack timers.
	// The process-wide converter admission pool (audit MEDIA-01, 2026-09-05):
	// ONE lazily built ConverterAdmission holding the permit count for heavy image /
	// PDF / SVG conversions. Config-derived and boot-stable — it holds a COUNT and a
	// FIFO of pending continuations, never a user, a session, a language or a record,
	// and it is deliberately process-wide because the resource it bounds (this box's
	// RAM, disk and cores) is process-wide: a request-scoped pool would bound each
	// request against itself and nothing against K of them, which is the defect.
	'core/media/engine/admission.ts:processAdmission',
	// The AV twin of the same pool (audit MEDIA-01, the ffmpeg half): a second
	// process-wide permit count, for the ffmpeg producers rather than the image
	// converters. Same contents (a count + a FIFO of continuations, never a
	// principal, a language or a record) and the same reason for being
	// process-wide: it bounds this box's cores, which no request owns.
	'core/media/engine/admission.ts:processAvAdmission',
	'core/security/session_media.ts:sweepTimer',
	// Warn-once latch for the reconcile refusal (SEC-09, 2026-08-28). The hourly sweeper
	// skips the marker half when this process holds a throwaway session store against an
	// unmarked media root; without the latch that warning repeats every hour for the life
	// of the process. Holds a boolean, is never read for a decision about a request, and
	// a stale `true` only means the sentence is not repeated.
	'core/security/session_media.ts:announcedUnsafeReconcile',
	// Once-per-process latch for the dd131 'Active account' census (SEC-07): a boolean
	// that stops the same installation-wide COUNT(*) being re-run on every login that
	// meets a record with no dd131 datum. Holds a boolean, never a record, a user or a
	// language; a stale `true` only means the count is not repeated in this process.
	'core/security/auth.ts:missingActiveAccountCensusDone',
	// Process-lifecycle latches (audit S2-17/S3-46, WS-E): request-INDEPENDENT
	// by construction — shuttingDown is the signal-handler idempotency latch,
	// lastPurgeAt throttles the daily residue purge on the sweeper cadence.
	'server.ts:shuttingDown',
	'diffusion/jobs/scheduler.ts:lastPurgeAt',
	// section_id deprecation-counter observer (D10 of the WC entry
	// WC-2026-08-10-section-id-int-canonical): wired ONCE at boot to
	// api/counters incrementCounter (the
	// registerOpsGauge inversion — concepts/ is a pure leaf and cannot import
	// api/). Carries no request identity: the per-door SOURCE string is code-
	// authored, never user data.
	'core/concepts/section_id.ts:coercionObserver',
	// The graceful-shutdown entry point injected ONCE by startServer so a planned
	// restart drains like a SIGTERM (core/install must not import the process
	// root). Boot-stable process wiring — carries no request identity.
	'core/install/restart.ts:gracefulShutdown',
	// "Is curl on PATH" memo for the AI-model downloader: a fact about the HOST
	// (boot-stable, request-independent), probed once per process on first
	// download. Never cleared — the binary set does not change under a running
	// server, and a wrong stale value only changes WHICH transport fetches.
	'core/ai/model_fetch.ts:curlChecked',
	// Registry-pairing cache GENERATION counter (2026-08-14): bumped by every
	// invalidation of the hierarchy53→hierarchy58 map so a build that began
	// before the bump refuses to install its stale snapshot (the populate/
	// invalidate TOCTOU the pairing map would otherwise have). A monotonic
	// integer compared only for equality — ontology/registry-derived, never
	// request identity; the DATA it guards is the same ontology-scoped fact for
	// every user, session and language.
	'core/ontology/model_section.ts:pairingEpoch',
	// Ontology-update single-flight latch (UPDATE_PROCESS Phase 2, WC-023):
	// two concurrent ontology imports must never interleave DELETEs — ops
	// state, never request identity; set/cleared around one admin operation.
	'core/ontology/ontology_update.ts:updateInFlight',
	// move_* transform EXECUTE single-flight claim (OPS-6/PERF-11 r3): taken by
	// the widget door before the job is submitted, freed when its worker settles
	// (or the job ends unstarted) — ops state, never request identity.
	'core/update/transform/engine.ts:transformRunClaimed',
	// Pool-saturation gauge (WS-E observability): process-wide slot accounting
	// decremented/incremented around every pool acquire — ops state, never
	// request identity; read by the counters endpoint.
	// The relation-CLOSURE gauge (audit PERF-04): a high-water mark of the biggest
	// equivalence class this process has walked, plus how many walks were refused
	// at the bounds. Ops accounting, published on GET /api/v1/counters — it holds
	// two integers and can hold nothing else: no principal, no language, no
	// section, no record. A stale value only ages a number on an ops page.
	'core/relations/related.ts:closureStats',
	// The frozen client-asset MANIFEST (audit PERF-13): the service-worker
	// pre-cache list plus its cache key, computed ONCE at boot because building it
	// is a recursive readdir of the client tree plus a stat per file — thousands of
	// synchronous syscalls that used to run on an authenticated request path and
	// stall the whole event loop. Derived from FILES ON DISK, which cannot change
	// under a running server without a deploy (and a deploy restarts it); dev mode
	// recomputes per call instead of reading this. Carries no request identity.
	'core/api/dedalo_files.ts:manifestState',
	// The lazily built MAINTENANCE pool lane (PERF-11): one process-wide pool
	// + its slot gate, built on first maintenance use. Holds connections and
	// slot accounting only — no principal, no language, no record. (The slot
	// state that used to be the top-level availablePoolSlots/poolSlotWaiters now
	// lives inside each makeSlotGate closure.)
	'core/db/postgres.ts:maintenanceLane',
	// Its NON-TRANSACTIONAL twin (runWithoutStatementTimeout's lane — the same
	// gate, its own application_name the shutdown cancel spares): lazily built,
	// connections only, no request identity.
	'core/db/postgres.ts:nonTransactionalLane',
	// The full-read slot of backup verification (OPS-1, 2026-09-30): the settle-
	// promise of the last `pg_restore -f /dev/null` queued, so at most one multi-GB
	// read runs at a time. A FIFO of promises — no principal, no language, no
	// record; each reader releases its link in a `finally`.
	'core/area_maintenance/backup.ts:deepReadTail',
	'core/tools/loader.ts:loadedTools',
	'core/tools/loader.ts:collisions',
	// Names whose server module failed to load on the last scan (fail-closed
	// availability): boot/install-stable, same lifecycle as `collisions` —
	// rebuilt per scan, cleared by resetLoadedTools. No request identity.
	'core/tools/loader.ts:failedLoads',
	'core/tools/loader.ts:loadingPromise',
	// Lang-INDEPENDENT registry row data only (S1-13): the per-request label is
	// resolved per call in getElementTools, which also builds a fresh
	// simpleContext per call — nothing cache-owned reaches a caller.
	'core/tools/registry.ts:registeredToolsCache',
	// The RAW rows the line above (and every other registry reader) is built
	// from — same lifecycle, cleared by the same resetRegistryCache(). Raw rows
	// only: the lang-dependent label is resolved per request by the callers, so
	// nothing lang-bearing is cache-owned.
	'core/tools/registry.ts:activeToolRowsCache',
	'core/tools/paths.ts:rootsCache',
	'core/tools/config.ts:defaultConfigCache',
	'core/tools/config.ts:installConfigCache',
	// One-second memo of WHICH job pfiles exist on disk (media/jobs.ts). Request-
	// INDEPENDENT by construction: it caches a DIRECTORY LISTING of a private
	// tree, never a record, a user or a language. The in-memory registry is read
	// FIRST and is never memoized, so anything this process owns stays current;
	// this only bounds the repeated blocking readdir the activity tray put on the
	// request path. Deliberately not the parsed bodies — a stale body could report
	// a dead job as running.
	'core/media/jobs.ts:mirrorScan',
	'core/section/locks.ts:tableReady',
	// Bootstrap memo for the temporal scratch table (WC-079): a boolean, no
	// request identity. Cleared only by a process restart, which is correct —
	// CREATE TABLE IF NOT EXISTS is idempotent and the DDL cannot un-apply.
	'core/section/record/temporal_store.ts:tableReady',
	// Same shape for the P0-14 record-generation epoch store: a boolean bootstrap
	// memo, no request identity. The table's authority is
	// install/db/migrations/0005_record_generation.sql; this memo exists because
	// the INSTALLER mints records before any boot migration has run.
	'core/db/record_generation.ts:tableReady',
	'core/resolve/environment.ts:pgVersionCache',
	'core/diffusion_bridge/diffusion_map.ts:mapCache',
	'core/diffusion_bridge/diffusion_map.ts:targetsCache',
	'core/relations/select_lang.ts:resolvedLangsCache',
	'core/area/color.ts:crcTable',
	'core/section_record/save_event.ts:ragRecordHook',
	// Media-ingest registration seam (ragRecordHook precedent, same shape and
	// same lifecycle): a single boot-registered function slot notifying that a
	// record's media changed on disk. An upload does not go through the record
	// save path — files_info is written directly and fires no save event — so
	// without this seam new media is never noticed. It holds a FUNCTION, set
	// once at boot from initRagHooks; request identity can never land in it,
	// and the event it carries states its own identity explicitly precisely
	// because the upload path has no ALS scope open.
	'core/media/ingest/ingest_event.ts:mediaIngestHook',
	// S2-20 inversion seam: the component registry registers its model lookup
	// (alias/column fields) into the ontology resolver at module load — a
	// boot-stable function slot (same shape as ragRecordHook above), never
	// request identity.
	'core/ontology/resolver.ts:componentModelFieldsLookup',
	'core/search/search_related.ts:relationTablesCache',
	'core/db/dd_ontology.ts:activeTldsCache',
	// Same shape/lifecycle as activeTldsCache: ontology CONTENT (which TLDs carry
	// nodes beyond their bare `<tld>0` registry root), carries no request
	// identity, hub-cleared by the same registerOntologyCacheClearer callback.
	'core/db/dd_ontology.ts:populatedTldsCache',
	// GeoIP country reader (section Activity dd542 IP→country). A boot-stable,
	// request-INDEPENDENT in-memory database loaded once from a static .mmdb file
	// (mmdb-lib Reader) and shared read-only across requests — derives from a
	// downloaded file, never from ontology/records/session/lang/principal. Same
	// lifecycle as the static-asset gzip cache; not a cache-factory resource.
	'core/geoip/reader.ts:reader',
	// Diffusion job service (DIFFUSION_SPEC §4.2) — all request-INDEPENDENT
	// process state: a table-bootstrap memo plus the scheduler's process-wide
	// timers (the tick's single-flight latch lives in a closure: coalescingKick).
	// No request identity (user/session/lang) ever lands here; per-run state
	// lives in the durable dedalo_ts_diffusion_jobs rows.
	'diffusion/jobs/schema.ts:ensured',
	'diffusion/jobs/scheduler.ts:schedulerTimer',
	'diffusion/jobs/scheduler.ts:sweeperTimer',
	// Diffusion plan compiler (DIFFUSION_SPEC §4.1): a lazily-imported parser
	// classifier memo and the ontology-revision counter that keys the plan
	// cache — both request-INDEPENDENT (ontology/install-stable, bumped only
	// by the core cache-invalidation hub on ontology writes).
	'diffusion/plan/compile.ts:registryClassifier',
	'diffusion/plan/cache.ts:ontologyRevision',
	// Native-delete registration seam (ragRecordHook precedent): holds a
	// boot-registered executor function, never request identity.
	'core/diffusion_bridge/diffusion_delete.ts:nativeSqlDeleteExecutor',
	// Native media-index registration seam (S2-31, same pattern as the delete
	// executor above): boot-registered marker-store ops functions, never
	// request identity.
	'core/diffusion_bridge/diffusion_delete.ts:nativeMediaIndexOps',
	// Scheduler pause switch (admin flow control via the diffusion_server_control
	// widget) — process-wide operational state, no request identity.
	'diffusion/jobs/scheduler.ts:paused',
	// Drain latch (the same widget's quiesce action) — makes drainAndResume
	// idempotent across two admins and lets resumeScheduler abort an in-flight
	// wait. Process-wide operational state, no request identity.
	'diffusion/jobs/scheduler.ts:draining',
	// Reconcile registry + scheduler (audit 2026-08-26 S-10): the gauge
	// registration latch, the scheduler's armed latch and its interval handles —
	// process-wide wiring like diffusion/jobs/scheduler.ts above; no request
	// identity (a run is keyed by reconcile NAME, actor-less by design).
	'core/reconcile/registry.ts:gaugeRegistered',
	'core/reconcile/scheduler.ts:started',
	// Publication API push single-flight latch (publication host phase 4): set
	// synchronously before the first await of an APPLY round, cleared in finally.
	// Process-wide operational state like the reconcile scheduler's latch above —
	// it says only "a push is running", never who asked (the actor rides the call).
	'core/publication_host/api_reconcile.ts:applyRunning',
	// The last Publication API round's verdict (phase 4): the panel shows it instead
	// of hashing two API trees on every get_value. Install-static facts (the running
	// tree's release or refusal + a time), overwritten by every round, never identity.
	'core/publication_host/api_reconcile.ts:lastVerdict',
	// Retention scheduler (audit 2026-08-26 P2-9): the armed latch and the daily
	// interval handle. Same class as the reconcile scheduler above — process-wide
	// wiring, no request identity (a retention pass is keyed by STORE name and has
	// no actor at all).
	'core/retention/scheduler.ts:started',
	'core/retention/scheduler.ts:timer',
	// Login-timing decoy hash (foundation audit AUTHZ-03): a memoized Argon2id
	// hash of a random string, verified against on the no-user / legacy-hash
	// failure paths so login timing never reveals whether an account exists.
	// Request-INDEPENDENT — a fixed process-global decoy, never user/session state.
	'core/security/auth.ts:decoyHashPromise',
	// Media-index test seam (S2-31 port): guarded temp-dir-only base override,
	// set/cleared by the marker-store tests around each case — never request
	// identity (the production base is install-static config.media.rootPath).
	'diffusion/targets/mediastore/media_index.ts:baseOverrideForTests',
	// The started media-copy worker (PUBLICATION_HOST_SPEC §5.2, M3/M4): set once by
	// startMediaCopyWorker at boot, cleared by its stop (shutdown drain, gates). It
	// holds per-HOST lanes (registry names) and marker keys, never a user, session
	// or language; a second start is refused.
	'diffusion/targets/mediastore/media_copy_worker.ts:activeWorker',
	// Media-copy test seam (publication-host copy mode): the same guarded temp-dir-only
	// shape as the marker-store seam above — it refuses any non-temp path, so a test can
	// never point the sha-cache writer at the real <private>/media_copy. Set and cleared
	// around each case; never request identity (production is install-static privateDir).
	'diffusion/targets/mediastore/media_copy.ts:stateDirOverrideForTests',
	// Media-protection test seam (Rule A port): the same guarded temp-dir-only shape as
	// the marker-store seam above — it refuses any non-temp path, so a test can never
	// point the auth-marker writer or the rule-file writer at a real media tree. Set and
	// cleared around each case; never request identity (the production paths are
	// install-static: config.media.rootPath and <private>/).
	'core/media/protection.ts:pathOverridesForTests',
	// Publication-host stores test seam (phase 3, 2026-10-03): the
	// core/media/protection.ts:pathOverridesForTests shape, stricter — it accepts only a
	// directory under the OS temp dir that carries `.dedalo_test_publication_hosts`, so no
	// test can point the registry or the secret writer at a real <private>. Holds a PATH,
	// never request identity; null in production, set and cleared around each case
	// (test/helpers/publication_host_fixtures.ts).
	'core/publication_host/registry.ts:baseOverrideForTests',
	// REMOVED 2026-08-24 with the per-session media credential
	// (WC-2026-08-24-media-auth-session-scoped). It cached "today's install-wide cookie
	// value" so the per-request re-issue could be a string compare instead of a JSON
	// store read. There is no install-wide value any more: the credential lives on the
	// session row, so the re-issue compares against data the request already loaded and
	// the module holds no cross-request state at all. Deleted rather than left as a dead
	// allowlist line — a stale exemption pre-authorizes the next binding to land there
	// unseen, which is why this gate treats staleness as red.
	// The external subsystem's ONE settings door (src/external/settings.ts). Holds
	// OPERATOR settings only — the frozen config is built at import, and `bun test`
	// shares one module graph, so a test cannot state a scenario any other way
	// (the core/media/protection.ts:pathOverridesForTests precedent, same shape and
	// same lifecycle: null in production, set and cleared around one case).
	// Request identity can never land in it: its type is the operator config.
	'external/settings.ts:overridesForTests',
	// IDEMPOTENCY LEDGER byte accounting (CLI-01 / P0-10,
	// WC-2026-08-28-idempotency-key). The running total of the answer bytes the
	// ledger below holds — the second half of its memory bound, read by
	// ledgerOverCapacity() and by the /health-adjacent stats seam. It is an
	// INTEGER, never request identity: nothing user-, session- or lang-shaped can
	// land in a byte count, and the identity that DOES exist lives inside each
	// ledger KEY (which embeds the authenticated principal), never here.
	// LIFECYCLE: incremented when a leader stores its outcome, decremented by
	// dropLedgerEntry on every eviction, and zeroed with the map by the test seam.
	'core/api/dispatch.ts:idempotencyLedgerBytes',
	// RFC 7050 NAT64 prefix discovery cache (the SSRF guard, security/ssrf_guard.ts).
	// Holds the NAT64 prefixes of the NETWORK this process sits on — install/host
	// state, never a user, session, language, record or request. It is TIGHTEN-ONLY
	// (a discovered prefix can refuse an address, never admit one the IPv6 rules
	// refuse), so a stale value can only refuse more. LIFECYCLE: refreshed lazily by
	// assertPublicUrl once expiresAt passes (10 min after an answer, 60 s after an
	// empty one, which KEEPS the previous prefixes — nextNat64Discovery); never
	// written by a call that injects its own resolver (deps.lookup bypasses it both
	// ways). Process restart otherwise.
	'core/security/ssrf_guard.ts:nat64Discovered',
	// The refresh in flight, so concurrent first calls share ONE lookup (the
	// in-flight coalescing precedent of external/cache.ts:inFlight). Holds a
	// promise of the same host-level prefixes. LIFECYCLE: set when a refresh starts,
	// cleared in that refresh's own `finally`.
	'core/security/ssrf_guard.ts:nat64DiscoveryInFlight',
]);

/**
 * Known, reviewed module-level MUTABLE `new Map()`/`new Set()` declarations
 * NOT created through ontology/cache_factory.ts (the WS-B factory gate,
 * DEC-13 rule 1). Every entry must state its LIFECYCLE: who clears it, and
 * when (DEC-12 refinement). ReadonlyMap/ReadonlySet-typed declarations are
 * exempt from the scan — annotate frozen constant tables instead of listing
 * them here. A NEW module-level cache belongs in the factory, not in this
 * list.
 */
const ALLOWLISTED_MODULE_MAPSET = new Set<string>([
	// Backup verifications in flight (OPS-1, 2026-09-30): keyed on FILE IDENTITY
	// + how it is judged (realpath|size|mtimeMs|budgetMs|bin) — never request
	// identity, so two askers of the same bytes share the same bytes' verdict.
	// Deleted the moment the read settles; only a TIMEOUT verdict is memoized,
	// 15 min, swept on every access (sweepTimeoutMemo).
	'core/area_maintenance/backup.ts:verifyInFlight',
	// Backup-directory scans in flight (OPS-1): keyed on the directory (+ its
	// verify options), deleted when the walk settles — the panel's bounded wait
	// and the pipeline's settled ask share one walk. No request identity.
	'core/area_maintenance/backup.ts:scanInFlight',
	// The in-flight dump parts THIS process claimed (OPS-2 review): absolute paths
	// added at the claim, removed when the dump job settles — so the orphan
	// adoption never judges a live dump of ours. No request identity.
	'core/area_maintenance/backup.ts:partsInFlight',
	// Orphan adoptions in flight, keyed on the resolved backup directory, deleted
	// when the pass settles — concurrent dumps share one pass. No request identity.
	'core/area_maintenance/backup.ts:adoptionInFlight',
	// Publication API bundle builds in flight (phase 4, L3): keyed on backupRoot +
	// release id + api — never request identity — so the boot-confirm hook and a
	// panel push of the same release share one `bun install`. Deleted the moment the
	// build settles (`.finally`); a restart clears it.
	'core/publication_host/api_bundles.ts:buildsInFlight',
	// Panel kit builds in flight (kit_build.ts), keyed backupRoot + release + draft name —
	// never request identity — so a double click shares one install. Deleted the moment the
	// build settles (`.finally`); a restart clears it.
	'core/publication_host/kit_build.ts:kitBuildsInFlight',
	// Publication-host READ proofs (phase 3, E6): host NAME → the registry fingerprint +
	// address its unauthenticated /health proved. A fact about a fixed registry entry —
	// no user, session or language. Success only; deleted on any transport failure, a
	// 401, a status body naming another fingerprint, a failed proof and forgetPairing.
	// A re-pair in ANOTHER process (pair CLI) changes the key, so the next read re-proves;
	// mutations never consult it (they prove live on every call).
	'core/publication_host/agent_client.ts:provenPairings',
	// Per-host serialization of the publication-host AFTER-CHANGE probe (phase 6):
	// keyed on the registry host name, never request identity; an entry is deleted
	// when its own probe settles, so at most one queued lane per changing host.
	'core/publication_host/probe.ts:probeLanes',
	// Bootstrap memo for matrix_time_machine.tm_role (ensureTmRoleColumn — the
	// self-heal when migration 0010 did not land at boot): the TABLES verified
	// to carry the column. No request identity; set only on success, cleared by
	// a restart, and the DDL cannot un-apply.
	'core/db/record_generation.ts:tmRoleReadyTables',
	// Model-artifact digest VERDICT cache (2026-09-04, P1-25): absolute path →
	// {size, mtimeMs, ino, sha256}, so the serving door hashes a gigabyte weight
	// once per process and re-hashes only when the stat identity moves. A digest
	// is the same fact for every user, session and language — boot-stable, no
	// request identity. Cleared per entry by `forgetVerdict` (quarantine, repair);
	// a stale entry cannot mask a changed file because the identity check fails.
	'core/ai/model_integrity.ts:verdicts',
	// FOUND 2026-08-31 by widening this census to tools/ (P2-20 / GATE-34).
	// PROCESS-level job liveness, not request state: it maps a model name to the
	// download/repair claim currently running, so a second request refuses instead
	// of racing. Cleared in the `finally` of the job it guards.
	'tools/tool_transcription/server/index.ts:modelJobsInFlight',
	// --- invalidation/registration infrastructure (the channels the factory
	// registers into; registration-only, grow with module loads, never cleared
	// by design) --------------------------------------------------------------
	'core/ontology/cache_invalidation.ts:registeredClearers',
	'core/section_record/save_event.ts:sectionDataListeners',
	// Registry-pairing invalidation channel (2026-08-14): the inversion that
	// lets relations/datalist.ts drop option lists derived from a
	// hierarchy53→hierarchy58 pairing without ontology/ importing relations/.
	// Same class as the two channels above — registration-only, grows with
	// module loads, never cleared by design, and its members are code-authored
	// callbacks that carry no request identity.
	'core/ontology/model_section.ts:pairingChangeListeners',
	// dd1758 activity-table seam: the scratch-table bootstrap latch (the
	// diffusion/jobs/schema.ts:ensured twin), keyed by RESOLVED table name —
	// the table is resolved per call now, so one latch per name. A
	// process-lifecycle DDL memo, only ever populated under the test-only
	// DIFFUSION_ACTIVITY_TABLE override; no request identity. Cleared by
	// nobody on purpose: a created table stays created for the process, and a
	// failed bootstrap deletes its own entry so the next call retries.
	'core/diffusion_bridge/diffusion_delete.ts:activityTableEnsured',
	// section_id coercion WARN sampler (WC-2026-08-10-section-id-int-canonical
	// D10): per-door tallies deciding which coercions log (first + every
	// 1000th). Process-lifetime like api/counters itself, request-independent
	// (keys are code-authored door names); cleared only by the test seam
	// resetSectionIdCoercionStateForTests.
	'core/concepts/section_id.ts:warnCounts',
	// File-processor registry (SEC-053 fail-closed allowlist — crop_50 is the
	// first ported entry, tools/tool_import_files/server/index.ts registers it
	// at module load): registration-only like the two channels above — a
	// Readonly type would outlaw the registerFileProcessor door it exists to provide.
	'core/tools/import_files_match.ts:FILE_PROCESSORS',
	// (The former "frozen constant tables" block — 17 Sets — was annotated
	// ReadonlySet at the declarations 2026-07-10 and removed from this list:
	// the type system now enforces what the exemption merely asserted.)
	// --- process-lifetime OPS state (not content caches; lifecycle: process
	// restart, or the stated owner) ------------------------------------------
	// Background tool-job registry (S2-16): keyed by job id; terminal entries
	// pruned by its own retention sweep; ops visibility state.
	'core/tools/background.ts:jobs',
	// Live bulk-run registry (2026-09-27, decision D5 of the bulk-revert undo
	// log): the dd800 ids whose run is executing in THIS process, and the ids a
	// revert is undoing right now. Process-wide facts about in-process work —
	// keyed by bulk id, never by principal or language. Each entry is removed in
	// the `finally` of the run/revert that added it (withLiveBulkRun /
	// releaseBulkRevert), so the sets drain themselves; a restart empties them,
	// which is correct because no bulk run survives one.
	'core/tools/bulk_run_registry.ts:liveBulkRuns',
	'core/tools/bulk_run_registry.ts:revertsInFlight',
	// Request/gauge counters (WS-E observability): monotonic ops metrics,
	// never cleared by design.
	'core/api/counters.ts:counters',
	'core/api/counters.ts:gaugeProviders',
	// Activity providers (the job tray's read model): the SAME inversion as
	// gaugeProviders above and with the same lifecycle — subsystems register at
	// BOOT because core/api may not import src/diffusion, and the map is written
	// once per process and read-only thereafter. It holds FUNCTIONS, not data:
	// nothing request-derived is stored, so there is nothing to leak between
	// requests and nothing to invalidate.
	'core/api/activity.ts:activityProviders',
	// Reconcile registry (S-10): `definitions` is the same registration-only
	// inversion as gaugeProviders (written at boot, holds definitions, never
	// request-derived data); `lastRuns` is the per-name last-outcome record the
	// `reconcile` gauge publishes — ops visibility state with the counters'
	// lifecycle (process restart; resetReconcileRunsForTests for gates).
	'core/reconcile/registry.ts:definitions',
	'core/reconcile/registry.ts:lastRuns',
	// Reconcile scheduler interval handles: armed by startReconcileScheduler,
	// cleared by stopReconcileScheduler (SIGTERM drain). Timers, not data.
	'core/reconcile/scheduler.ts:timers',
	// The retention registry's definition table (audit 2026-08-26 P2-9): one entry
	// per append-only store, filled once at import by core/retention/prune.ts and
	// never per request. A closed set — registerRetention refuses a name outside
	// REGISTERED_NAMES — so it cannot grow at runtime.
	'core/retention/registry.ts:definitions',
	// Diffusion MariaDB pool cache: one pool per DSN for the process lifetime;
	// closed on shutdown by the graceful-drain path.
	'diffusion/targets/mariadb/db.ts:poolCache',
	// Target-DB reachability verdicts for the INFO panels (WC-065
	// connection_status): { result, msg } keyed by database name. NOT a content
	// cache and not ontology/record-derived — it memoizes a remote server's
	// LIVENESS, which no write event invalidates, so neither cache_factory
	// lifecycle applies. Lifecycle: every entry self-expires 10s after it was
	// written (checked on read), and the whole map is cleared by
	// closeAllTargetPools (tests / shutdown). No request identity: a target
	// database name is install state.
	'diffusion/targets/mariadb/db.ts:probeStatusMemo',
	// Media-index per-key mutation chains (S2-31 port, oracle with_key_lock):
	// a serialization primitive, NOT a content cache — each entry is deleted
	// in the finally of the very chain it serializes (self-draining); keys are
	// marker names, never request identity.
	'diffusion/targets/mediastore/media_index.ts:keyLocks',
	// The pub/ transition seam's sinks (PUBLICATION_HOST_SPEC §5.2, M3): boot
	// wiring — the media-copy worker registers ONE sink at boot and removes it on
	// shutdown (the returned unregister); gates add/remove their own around each
	// case. Functions, never request identity; not a cache.
	'diffusion/targets/mediastore/pub_transitions.ts:sinks',
	// --- content caches with a NON-hub invalidation contract (lifecycle
	// documented at the declaration site) -------------------------------------
	// Install-static media type specs (concepts/media.ts): derived from code
	// constants, not from dd_ontology or record data — nothing invalidates it
	// because nothing can change it at runtime.
	'core/concepts/media.ts:specCache',
	// "Can this ImageMagick, under OUR hardened policy, write a .<ext> file"
	// (engine/imagemagick.ts:canWriteImageFormat). A fact about the HOST — the
	// installed delegates plus the shipped policy.xml — probed once per process
	// with a real 1x1 encode. Key is the resolved magick binary path plus a file
	// extension, value a boolean promise: request identity cannot land in it.
	// Lifecycle: process restart for a `true` (false is dropped) — neither the
	// binary's delegates nor the shipped policy can change under a running server,
	// and the binary in the key means a second magick is probed, not answered for
	// (the engine/ffmpeg.ts:audioCodecByBinary precedent).
	'core/media/engine/imagemagick.ts:writableFormatCache',
	// AAC-encoder pick per ffmpeg BINARY PATH (engine/ffmpeg.ts:getAudioCodec).
	// A fact about one executable: key a path, value an encoder name — request
	// identity cannot land in it. Keyed by the binary (not a process scalar) so a
	// second ffmpeg resolved in-process is re-probed: the scalar it replaced let a
	// fake binary's libfdk-aac answer break every later real encode. Inconclusive
	// probes are dropped, so lifecycle = process restart for conclusive answers only.
	'core/media/engine/ffmpeg.ts:audioCodecByBinary',
	// Tool filesystem-root resolution: cleared by resetPathsCache via
	// invalidateAllToolCaches on TS-side tool writes; COEX restart rule for
	// PHP-side writes (tools/cache.ts header).
	'core/tools/paths.ts:rootResolutionCache',
	// Static-asset gzip bytes: derived from FILES on disk (not ontology/record
	// data — the factory is the wrong lifecycle). Entries self-evict when the
	// stat-derived ETag diverges (client re-sync); bounded by the servable
	// client tree; process-lifetime otherwise (static_asset.ts header).
	'core/api/static_asset.ts:gzipCache',
	// Diffusion publication plans: revision-keyed (ontologyRevision bumped by
	// the hub via plan/cache.ts registration) — its own documented scheme, not
	// a clear-on-fire Map.
	'diffusion/plan/cache.ts:planCache',
	// --- external record services (src/external) -----------------------------
	// Circuit state per (service, ORIGIN). Deliberately NOT factory-built: the
	// factory's clearer fires after EVERY dd_ontology write, so an unrelated
	// cataloguing save would reset an open circuit and re-open the flood at a
	// failing third party (v6 kept this in $_SESSION, which additionally bled
	// between users). Lifecycle: TIME ONLY — a success deletes its entry, and
	// every access prunes entries untouched for 10 cooldowns. Keys are a service
	// name and a host; never session/user/lang.
	'external/breaker.ts:breakerStates',
	// Per-(service, origin) parallelism bound at the one outbound door. NOT a
	// content cache — slot accounting. Lifecycle: SELF-DRAINING, deleted the
	// moment the last holder releases with nobody waiting (the media_index
	// keyLocks precedent).
	'external/transport.ts:concurrencySlots',
	// --- the harvesting door (src/core/harvest) --------------------------------
	// robots.txt verdicts per ORIGIN. NOT factory-built: robots.txt derives from a
	// remote site, which neither invalidation channel knows about. Lifecycle: TIME
	// and SIZE — 1 h TTL (5 min for an unavailable verdict), replaced on the next
	// ask once expired, oldest insertion evicted past 512 origins OR past
	// ROBOTS_CACHE_MAX_WEIGHT (16 MiB) of what the entries retain — rule objects
	// as well as pattern text; a load that
	// REJECTS (a refused origin) deletes its own entry, so a refusal is never
	// remembered. Keys are origins, never session/user/lang.
	'core/harvest/robots.ts:robotsPolicies',
	// Per-ORIGIN pacing queue. A serialization primitive (the concurrencySlots
	// precedent above), not a cache. Lifecycle: SELF-DRAINING — an unref'd drain
	// timer deletes the entry once nobody waits and its interval has passed (a
	// timer that fires early re-arms, so no idle entry is stranded);
	// clearPacingForTests empties it for gate isolation.
	'core/harvest/pacing.ts:originPaces',
	// In-flight fetch coalescing, keyed by the row cache key. A serialization
	// primitive, not a cache: each entry is deleted in the `finally` of the very
	// fetch it coalesces. The ROW cache beside it IS factory-built.
	'external/cache.ts:inFlight',
	// In-flight SEARCH coalescing, keyed by (service, section, method, url). Same
	// serialization-primitive lifecycle as cache.ts:inFlight — deleted in the
	// `finally` of the very fetch it coalesces. There is no factory cache beside
	// this one on purpose: a search is user-typed and high-cardinality, so its
	// results are deliberately NOT cached (src/external/search.ts header).
	'external/search.ts:inFlightSearches',
	// Log dedup ledger of the external subsystem's ONE logging door
	// (logExternalError): distinct failure line → epoch ms it was logged, so a
	// per-record failure repeated by every render/export row is COUNTED
	// (external_log_suppressed), not re-logged with a stack. NOT factory-built:
	// an ontology write says nothing about what the log already said. Lifecycle:
	// TIME-CLEARED (pruned past the 10-minute window on every admission) and
	// SIZE-BOUNDED (5 000 entries, oldest first). Keys are the disclosure-safe
	// log line — never session/user/principal/lang.
	'external/errors.ts:loggedLines',
	// The external subsystem's record-endpoint watch: (service, record endpoint
	// scheme/host/PATH) → consecutive record-path 4xx answers since the endpoint
	// last delivered a record, so an endpoint that answers 4xx for EVERY id (a
	// wrong api_url path, a moved route) is reported once and read as the source
	// failing instead of N silent not_founds. NOT factory-built: an ontology
	// write says nothing about whether an endpoint answers (a changed api_url is
	// a new key). Lifecycle: an entry is DELETED by the endpoint's next delivered
	// answer and PRUNED after an hour untouched. Keys are configuration — never
	// session/user/principal/lang.
	'external/record_answers.ts:recordAnswerStreaks',
	// --- the idempotency ledger (CLI-01 / P0-10) -----------------------------
	// GATE 4's ledger (WC-2026-08-28-idempotency-key): key -> the ONE outcome of
	// the operation that key names, so a transport resend replays it instead of
	// executing a second time. Deliberately NOT factory-built: the factory's
	// clearer fires after every dd_ontology write, and dropping this map would
	// re-admit the duplicate-heritage-record defect it exists to close — an
	// ontology save must not un-remember that a duplicate already ran.
	// NOT a content cache and never read as one: nothing consults it for DATA,
	// only for "has this exact operation already been performed". A key embeds the
	// AUTHENTICATED PRINCIPAL, so one user's entry can never answer another's
	// request; unauthenticated requests are never ledgered at all.
	// LIFECYCLE, stated exactly (the first draft's "swept on every insert" was
	// FALSE — the sweep ran only from the leader's success path): entries are
	// dropped by sweepIdempotencyLedger + sweepPrincipalEntries, which run (a) on
	// the READ path of every ledgered request, where the 15-minute TTL is actually
	// enforced, and (b) on every leader completion, SUCCESS AND FAILURE alike. An
	// in-flight entry is never evicted (its twin is owed an answer); a failed one
	// is KEPT on purpose, marked ambiguous, because a thrown handler may already
	// have committed. Cleared wholesale only by resetIdempotencyLedgerForTests.
	'core/api/dispatch.ts:idempotencyLedger',
]);

/** Mutation shapes for a named binding: assignment, ++/--, mutating methods. */
/**
 * Known, reviewed module-level `const` OBJECT/ARRAY literals that the owning
 * file MUTATES — all request-INDEPENDENT process/ops state (the `const`
 * spelling of ALLOWLISTED_MODULE_LET). Keyed `<path>:<name>`. A new entry
 * needs the same justification bar: no request identity (user/session/lang)
 * may ever land in it.
 */
const ALLOWLISTED_MODULE_CONST = new Set<string>([
	// Process-poison latch (first-load TDZ race detector): process-lifecycle
	// health state flipped once on a fatal init race — never request identity.
	'core/api/process_health.ts:poisonState',
	// DB reachability memo for /health: a timestamped ok/checkedAt pair on the
	// probe cadence — ops state, same class as the pool slot gate.
	'server.ts:dbHealth',
	// Request-latency aggregate (WS-E observability): monotonic count/total/max
	// ops metrics fed by access_log — never cleared by design, no identity.
	'core/api/counters.ts:latency',
]);

/** Mutation shapes for a named binding: assignment, ++/--, mutating methods. */
function mutationPatterns(name: string): RegExp[] {
	return [
		// Property/index assignment incl. compound ops (`=` but not `==`/`===`).
		new RegExp(
			`\\b${name}(?:\\.[\\w.]+|\\[[^\\]]*\\])\\s*(?:=(?!=)|\\+=|-=|\\*=|\\/=|%=|\\*\\*=|&&=|\\|\\|=|\\?\\?=)`,
		),
		// Increment/decrement on a property or index.
		new RegExp(`\\b${name}(?:\\.[\\w.]+|\\[[^\\]]*\\])(?:\\+\\+|--)`),
		// Mutating array methods (sort/reverse at module init are ordering, not state).
		new RegExp(`\\b${name}\\.(?:push|pop|shift|unshift|splice|fill|copyWithin)\\(`),
		// Map/Set/WeakMap/WeakSet-style mutation on an object-typed const.
		new RegExp(`\\b${name}\\.(?:set|add|delete|clear)\\(`),
		// delete operator.
		new RegExp(`\\bdelete\\s+${name}[.[]`),
	];
}

function scanSrc(): {
	moduleLet: string[];
	accessorCapture: string[];
	configLangCapture: string[];
	moduleMapSet: string[];
	moduleConstMutated: string[];
	/** Files the walk actually read — floored below so an emptied walk cannot pass. */
	scannedFiles: number;
} {
	const glob = new Glob('**/*.ts');
	let scannedFiles = 0;
	const moduleLet: string[] = [];
	const accessorCapture: string[] = [];
	const configLangCapture: string[] = [];
	const moduleMapSet: string[] = [];
	const moduleConstMutated: string[] = [];
	// Column-0 declarations only = module scope (anything inside a function/block
	// is indented with tabs in this codebase's style).
	const letRe = /^(?:export )?(?:let|var) (\w+)/;
	const captureRe =
		/^(?:export )?(?:const|let|var) \w+ *= *current(?:Principal|Session|ApplicationLang|DataLang)\(/;
	// S2-11 defect class: module-level capture of the install-default langs.
	const configLangRe =
		/^(?:export )?(?:const|let|var) \w+ *= *config\.menu\.(?:applicationLang|dataLang)\b/;
	// WS-B factory gate: module-level mutable Map/Set — Weak variants included
	// (a module-level WeakMap/WeakSet is always a cache); Readonly-typed exempt.
	const mapSetRe =
		/^(?:export )?(?:const|let|var) (\w+)(?::\s*([^=]+?))?\s*= new (?:Weak)?(?:Map|Set)\b/;
	// Mutated-const gate: column-0 const OBJECT/ARRAY literal (type annotation
	// tolerated, incl. `=>` inside it). Flagged only if the file mutates it.
	const constObjRe = /^(?:export )?const (\w+)(?::\s*(?:[^=\n]|=>)+?)?\s*= [{[]/;
	// BOTH TREES (P2-20 / GATE-34). These five detectors globbed `src/` only,
	// while tool SERVER code runs in the SAME PROCESS and handles requests — so
	// module-level state there bleeds across requests exactly as it would in
	// src/. This file's own `runDetachedFromTransaction` census already scanned
	// ['src','tools'], with a comment explaining why; the five above never got
	// the same treatment.
	// src/ keeps its BARE keys (the allowlists below are written that way);
	// tools/ entries are prefixed so the two trees stay distinguishable.
	const roots: [string, string][] = [
		[SRC_DIR, ''],
		[join(SRC_DIR, '..', 'tools'), 'tools/'],
	];
	for (const [root, prefix] of roots)
		for (const relRaw of glob.scanSync(root)) {
			const rel = `${prefix}${relRaw}`;
			scannedFiles++;
			const content = readFileSync(join(root, relRaw), 'utf8');
			const lines = content.split('\n');
			for (const line of lines) {
				const m = line.match(letRe);
				if (m) moduleLet.push(`${rel}:${m[1]}`);
				if (captureRe.test(line)) accessorCapture.push(rel);
				if (configLangRe.test(line)) configLangCapture.push(rel);
				const ms = line.match(mapSetRe);
				if (ms && !(ms[2] ?? '').includes('Readonly')) moduleMapSet.push(`${rel}:${ms[1]}`);
				const co = line.match(constObjRe);
				if (co && mutationPatterns(co[1] as string).some((re) => re.test(content))) {
					moduleConstMutated.push(`${rel}:${co[1]}`);
				}
			}
		}
	return {
		moduleLet,
		accessorCapture,
		configLangCapture,
		moduleMapSet,
		moduleConstMutated,
		scannedFiles,
	};
}

describe('module-state tripwire (§4 request isolation)', () => {
	const {
		moduleLet,
		accessorCapture,
		configLangCapture,
		moduleMapSet,
		moduleConstMutated,
		scannedFiles,
	} = scanSrc();

	test('the src/ + tools/ walk read a populated tree (anti-vacuity floor)', () => {
		// 600+ .ts files under src/ and tools/ on 2026-09-02. A walk that returns
		// fewer is a broken walk (wrong root, a glob that stopped matching), not a
		// smaller engine — and every allowlist below would pass vacuously on it.
		expect(scannedFiles).toBeGreaterThan(600);
		expect(moduleLet.length).toBeGreaterThan(10);
	});

	test('no NEW module-level let/var carrying request state (allowlist known-safe caches)', () => {
		const unexpected = moduleLet.filter((entry) => !ALLOWLISTED_MODULE_LET.has(entry));
		if (unexpected.length > 0) {
			throw new Error(
				`New top-level \`let\`/\`var\` binding(s) found:\n  ${unexpected.join('\n  ')}\nIf request-INDEPENDENT (boot/install-stable), add to ALLOWLISTED_MODULE_LET with a justification. If it could carry request identity (user/session/lang), make it request-scoped instead (see core/security/request_context.ts).`,
			);
		}
		expect(unexpected).toEqual([]);
	});

	test('allowlist stays honest — no stale entries for bindings that no longer exist', () => {
		const present = new Set(moduleLet);
		const stale = [...ALLOWLISTED_MODULE_LET].filter((entry) => !present.has(entry));
		expect(stale).toEqual([]);
	});

	test('no module-level binding captures a request-scoped accessor', () => {
		expect(accessorCapture).toEqual([]);
	});

	test('no module-level binding captures config.menu.applicationLang/dataLang (S2-11)', () => {
		// The per-request lang must be read at call time via currentDataLang()/
		// currentApplicationLang() — a module capture freezes the install
		// default for every session (see ts_object/term_resolver, WS-B item 4).
		expect(configLangCapture).toEqual([]);
	});

	test('no NEW module-level Map/Set cache outside the cache factory (WS-B/DEC-13)', () => {
		const unexpected = moduleMapSet.filter((entry) => !ALLOWLISTED_MODULE_MAPSET.has(entry));
		if (unexpected.length > 0) {
			throw new Error(
				`Module-level mutable Map/Set declaration(s) outside the cache factory:\n  ${unexpected.join('\n  ')}\nCreate caches via createOntologyCache/createDataCache (src/core/ontology/cache_factory.ts) so they are invalidation-registered by construction. A frozen constant table should be typed ReadonlyMap/ReadonlySet. Anything else needs an ALLOWLISTED_MODULE_MAPSET entry WITH a lifecycle justification (who clears it, and when).`,
			);
		}
		expect(unexpected).toEqual([]);
	});

	test('Map/Set allowlist stays honest — no stale entries', () => {
		const present = new Set(moduleMapSet);
		const stale = [...ALLOWLISTED_MODULE_MAPSET].filter((entry) => !present.has(entry));
		expect(stale).toEqual([]);
	});

	test('no NEW mutated module-level const object/array (the `const` spelling of `let` state)', () => {
		const unexpected = moduleConstMutated.filter((entry) => !ALLOWLISTED_MODULE_CONST.has(entry));
		if (unexpected.length > 0) {
			throw new Error(
				`Module-level \`const\` object/array literal(s) MUTATED by their own file:\n  ${unexpected.join('\n  ')}\nThis is module-level mutable state with a const badge. If request-INDEPENDENT (process/ops state), add to ALLOWLISTED_MODULE_CONST with a justification. If it could carry request identity (user/session/lang), make it request-scoped (see core/security/request_context.ts) or a factory-built cache (core/ontology/cache_factory.ts).`,
			);
		}
		expect(unexpected).toEqual([]);
	});

	test('mutated-const allowlist stays honest — no stale entries', () => {
		const present = new Set(moduleConstMutated);
		const stale = [...ALLOWLISTED_MODULE_CONST].filter((entry) => !present.has(entry));
		expect(stale).toEqual([]);
	});
});

/**
 * The transaction ALS's ONE escape hatch. `runDetachedFromTransaction` exits the
 * transaction + deferred-action stores, which is exactly right for a background
 * job (it outlives its submitter, whose handle expires at COMMIT — S2-14) and
 * exactly wrong for anything else: work wrapped in it loses read-your-writes and
 * cannot be rolled back with the request. Freeze the caller set so a future
 * "avoid holding the transaction" refactor has to argue its case here.
 * Contract + rationale: engineering/REQUEST_ISOLATION.md.
 */
describe('runDetachedFromTransaction — frozen caller set', () => {
	const ALLOWED_IMPORTERS = new Set([
		// The job manager: submit() runs inside a request, the worker must not.
		'src/core/media/jobs.ts',
		// The media-copy worker (PUBLICATION_HOST_SPEC §5.2): a pub/ flip is emitted
		// INSIDE a marker writer's transaction (a runner batch, the fenced media_index
		// reconcile); the copy run it schedules is background work that outlives that
		// writer and must never join its (expiring) handle — media_copy_worker_native
		// drives a flip from inside withTransaction and pins the run detached.
		'src/diffusion/targets/mediastore/media_copy_worker.ts',
	]);

	test('only the job manager imports the transaction-ALS escape hatch', () => {
		const glob = new Glob('**/*.ts');
		const importers: string[] = [];
		// src/ AND tools/: a tool handler imports postgres.ts directly (e.g.
		// tool_import_files pulls `sql` from it), so a src-only census would leave
		// the whole tool layer free to detach its writes.
		for (const [root, prefix] of [
			[SRC_DIR, 'src/'],
			[join(SRC_DIR, '..', 'tools'), 'tools/'],
		] as [string, string][]) {
			for (const rel of glob.scanSync(root)) {
				if (`${prefix}${rel}` === 'src/core/db/postgres.ts') continue; // its home
				if (readFileSync(join(root, rel), 'utf8').includes('runDetachedFromTransaction')) {
					importers.push(`${prefix}${rel}`);
				}
			}
		}
		const unexpected = importers.filter((rel) => !ALLOWED_IMPORTERS.has(rel));
		if (unexpected.length > 0) {
			throw new Error(
				`runDetachedFromTransaction used outside the job-manager submit path:\n  ${unexpected.join('\n  ')}\nDetaching hides a write from the ambient transaction: it cannot be rolled back and cannot read the transaction's own uncommitted rows. Only work that OUTLIVES the request (a supervised background job) may detach. See engineering/REQUEST_ISOLATION.md.`,
			);
		}
		expect(unexpected).toEqual([]);
		// Allowlist stays honest — a stale entry means the rule guards nothing.
		expect([...ALLOWED_IMPORTERS].filter((rel) => !importers.includes(rel))).toEqual([]);
	});
});

/**
 * THE WIDENED LANG-READ CENSUS (P0-7, audit DATA-01) — `config.menu.dataLang` /
 * `config.menu.applicationLang` ANYWHERE outside `src/config/`, not only in a
 * module-level binding.
 *
 * WHY THE OLDER RULE ABOVE WAS NOT ENOUGH. It matches one shape,
 * `^const NAME = config.menu.dataLang`, and every site the 2026-08-26 audit
 * found was a FUNCTION-LOCAL ternary — `translatable ? config.menu.dataLang :
 * 'lg-nolan'` inside an import loop — which is structurally invisible to it.
 * Three bulk import doors resolved their WRITE language that way. The write is
 * lang-sliced, so the process-wide install default REPLACED the operator's
 * actual working language on every imported row and an empty cell CLEARED it,
 * with `ok:true` returned. The defect class is not "a module binding"; it is
 * "the static install default standing in for the per-request language".
 *
 * SO THE RULE IS A CENSUS, not a ban: the install default has legitimate
 * readers (the ALS accessors that fall back to it, the dispatch seed that
 * builds the scope, a login page that has no session yet, install-wide index
 * builders, report labels). Each is enumerated below WITH ITS REASON and its
 * measured count, and the ratchet is SHRINK-ONLY — a file may lose reads, never
 * gain them, and a file absent from the census may have none at all.
 *
 * Entries marked OPEN are not endorsements: they are the same defect class,
 * outside the edit scope of the change that installed this census, and they are
 * what a later pass has to remove.
 *
 * HONEST LIMIT: the scan is textual and skips whole-line comments (`//`, `*`,
 * `/*`) so prose naming the anti-pattern does not count; a read sharing a line
 * with a trailing comment still does. It cannot see an aliased read
 * (`const {menu} = config; menu.dataLang`) — no such site exists today, and the
 * census going stale is what would surface one.
 */
describe('config.menu lang reads outside src/config/ (P0-7 census)', () => {
	/** file → {count: reads measured 2026-08-27, reason: why they are allowed}. */
	const CONFIG_LANG_READ_CENSUS: ReadonlyMap<string, { count: number; reason: string }> = new Map([
		// ── THE TWO HOMES ────────────────────────────────────────────────────
		[
			'src/core/resolve/request_lang.ts',
			{
				count: 1,
				reason:
					'THE APPLICATION-LANG ACCESSOR. currentApplicationLang() falls back to the install default outside a request scope — this IS the definition of the fallback, not a leak of it. The DATA twin no longer reads config.menu at all: currentDataLang() falls back to config.lang.dataLangDefault, the read chain\u2019s first candidate and always a declared data language (2026-08-27, DATA-01).',
			},
		],
		[
			'src/core/api/dispatch.ts',
			{
				count: 2,
				reason:
					'THE SEED. The one place the request-language ALS scope is opened; the install default is the LAST step of the cascade (session > pre-auth cookie > default). config.menu.dataLang is safe to seed a WRITE language with because src/config/ resolves it against the declared data languages first — a session that has chosen no language cannot be handed one the chokepoint refuses.',
			},
		],
		// ── NO SESSION EXISTS AT THE POINT OF READ ───────────────────────────
		[
			'src/core/api/handlers/login_context.ts',
			{
				count: 1,
				reason:
					'The LOGIN page ddo is built before any session exists; the pre-auth cookie is handled in dispatch, and the install default is the only remaining answer.',
			},
		],
		[
			'src/ai/rag/embed_source.ts',
			{
				count: 1,
				reason:
					'The RAG indexer OPENS its own scope for a SYSTEM principal (no session, no request): the index is an install-wide artifact, so the install application lang is the deliberate value. The DATA lang it pairs with is passed in per document.',
			},
		],
		[
			'src/ai/rag/image_source.ts',
			{
				count: 1,
				reason:
					'Same system-principal scope as embed_source, for the image index; the data lang comes from the caller (input.dataLang).',
			},
		],
		[
			'src/ai/mcp/tools/llm_map.ts',
			{
				count: 1,
				reason:
					'Builds the install-wide ontology map served to every agent — one artifact for all callers, not a per-request view, and it writes nothing.',
			},
		],
		[
			'src/core/test_data/synthetic_hierarchy_fixture.ts',
			{
				count: 2,
				reason:
					'A TEST-DATA generator: it seeds its rows in the install default on purpose and REPORTS the lang it used, so the gate reading the fixture knows which slice to expect.',
			},
		],
		// ── LABELS AND READ-PATH FALLBACKS (not a write language) ────────────
		[
			'src/core/ontology/data_io.ts',
			{
				count: 1,
				reason:
					'The ontology CENSUS label (getActiveOntologies). The write in the same file is lg-nolan, unaffected.',
			},
		],
		[
			'src/core/ontology/hierarchy_census.ts',
			{
				count: 1,
				reason:
					'The thesaurus CENSUS labels of hierarchy.json (buildHierarchyManifest) — an install-wide export file, the ontology.json twin; name_data/scope_note_data carry every lang item, the pick is only the human label. Nothing is written to storage.',
			},
		],
		[
			'src/core/section/record/create_record.ts',
			{
				count: 1,
				reason: "The section LABEL written into the new record's audit text, not a data value.",
			},
		],
		[
			'src/core/section/indexation_grid.ts',
			{
				count: 1,
				reason:
					'A READ fallback candidate list (main lang > nolan > project langs) — PHP get_component_data_fallback, whose main lang IS the install default.',
			},
		],
		[
			'src/core/ts_object/term_resolver.ts',
			{
				count: 1,
				reason:
					'Main-lang fallback for a hierarchy1 term READ. This is S2-11’s original site, filed UNVERIFIED by the 2026-07 foundation audit; a read serving the install default is a wrong LABEL, never a wrong stored byte.',
			},
		],
		[
			'tools/tool_import_dedalo_csv/server/index.ts',
			{
				count: 4,
				reason:
					'Four termByTipo() REPORT LABELS. The fifth read — this door’s write language, audit DATA-01’s primary site — was removed by P0-7; it now reads currentDataLang().',
			},
		],
		[
			'tools/tool_propagate_component_data/server/index.ts',
			{ count: 1, reason: 'A termByTipo() report label for the progress panel.' },
		],
		// ── OPEN: the same defect class, outside P0-7's edit scope ───────────
		[
			'tools/tool_posterframe/server/index.ts',
			{
				count: 1,
				reason:
					'One termByTipo() report LABEL only. The MediaIdentity lang — the language segment of a translatable media component’s file path — was the DATA-01 third site and is closed: it reads currentDataLang() now.',
			},
		],
	]);

	/**
	 * Reads measured over src/ + tools/ on 2026-08-27, after P0-7's threading and
	 * BOTH of its review rounds. SHRINK-ONLY, and it has only shrunk: 23 → 22.
	 * The two reads that went are the ones the second review removed — the write
	 * chokepoint's declared-set read (the set is built in src/config/, which this
	 * census exempts, and no longer takes DEDALO_DATA_LANG as an input at all) and
	 * the data half of the ALS accessor (currentDataLang() now falls back to
	 * config.lang.dataLangDefault, which is not a config.menu read).
	 */
	const CENSUS_TOTAL = 22;

	const LANG_READ = /config\.menu\.(?:dataLang|applicationLang)\b/;

	function censusLangReads(): Map<string, number> {
		const counts = new Map<string, number>();
		const glob = new Glob('**/*.ts');
		for (const [root, prefix] of [
			[SRC_DIR, 'src/'],
			[join(SRC_DIR, '..', 'tools'), 'tools/'],
		] as [string, string][]) {
			for (const rel of glob.scanSync(root)) {
				const path = `${prefix}${rel}`;
				// src/config/ is where the catalog lives — reading its own keys is the point.
				if (path.startsWith('src/config/')) continue;
				let hits = 0;
				for (const line of readFileSync(join(root, rel), 'utf8').split('\n')) {
					const trimmed = line.trim();
					// Prose naming the anti-pattern is not a read of it.
					if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
						continue;
					}
					if (LANG_READ.test(line)) hits += 1;
				}
				if (hits > 0) counts.set(path, hits);
			}
		}
		return counts;
	}

	const measured = censusLangReads();

	test('no file reads the install-default lang outside the enumerated census', () => {
		const unexpected = [...measured.keys()].filter((path) => !CONFIG_LANG_READ_CENSUS.has(path));
		if (unexpected.length > 0) {
			throw new Error(
				`config.menu.dataLang / config.menu.applicationLang read in file(s) with no census entry:\n  ${unexpected.join('\n  ')}\nThe install default is NOT the request's language. A WRITE door must resolve it from the request-language ALS (currentDataLang(), src/core/resolve/request_lang.ts) — the static value is lang-sliced onto storage, so it REPLACES the operator's actual language and an empty value CLEARS it (audit DATA-01). If the read is genuinely install-wide (an ALS seed, a login page with no session, an install-wide index, a report label), add an entry to CONFIG_LANG_READ_CENSUS WITH its reason.`,
			);
		}
		expect(unexpected).toEqual([]);
	});

	test('the census is SHRINK-ONLY — no file may gain a read', () => {
		const grown = [...measured.entries()]
			.filter(([path, count]) => (CONFIG_LANG_READ_CENSUS.get(path)?.count ?? 0) < count)
			.map(
				([path, count]) => `${path}: ${CONFIG_LANG_READ_CENSUS.get(path)?.count ?? 0} → ${count}`,
			);
		expect(grown).toEqual([]);
	});

	test('the three DATA-01 doors read currentDataLang(), positively', () => {
		// The census above reddens when `config.menu.dataLang` COMES BACK. It says
		// nothing about what replaced it — a door rewritten to read
		// `config.lang.dataLangDefault`, or a module-level capture, reproduces the
		// defect (a write landing in a language the operator was not editing) with
		// the census green. Pin the positive shape at each closed door.
		//
		// The duplicate door is a SPEAKING door (WC-2026-09-27 addendum
		// 2026-09-30): its lane is effectiveSaveLang(currentDataLang()) through
		// mainIdentity — no local translatable/NOLAN override (that override was
		// the S0-CHECKPOINT F3 defect: transliterable/iri copies filed in
		// lg-nolan while their save filed in the data lang). This pin is only a
		// pointer; its OUTCOME twin is history_door_lane_agreement_native cell
		// (2), which duplicates under a request data lang that is asserted to
		// differ from BOTH install defaults, so a door reading
		// config.menu.dataLang, config.lang.dataLangDefault or a module-level
		// capture files the copy in the wrong lane there and reds it.
		for (const [file, expected] of [
			['tools/tool_update_cache/server/index.ts', "translatable ? currentDataLang() : 'lg-nolan'"],
			['src/core/section/record/duplicate_record.ts', 'mainIdentity(tipo, currentDataLang())'],
			['tools/tool_posterframe/server/index.ts', 'translatable ? currentDataLang() : null'],
		] as const) {
			const src = readFileSync(join(import.meta.dir, '..', '..', file), 'utf8');
			expect(src, `${file}: the DATA-01 door no longer reads currentDataLang()`).toContain(
				expected,
			);
		}
	});

	test('the census stays honest — no stale entry, and every entry states WHY', () => {
		const stale = [...CONFIG_LANG_READ_CENSUS.keys()].filter((path) => !measured.has(path));
		expect(stale).toEqual([]);
		const reasonless = [...CONFIG_LANG_READ_CENSUS.entries()]
			.filter(([, entry]) => entry.reason.trim().length < 20)
			.map(([path]) => path);
		expect(reasonless).toEqual([]);
	});

	test('the measured TOTAL never grows past the recorded census', () => {
		const total = [...measured.values()].reduce((sum, count) => sum + count, 0);
		expect(total).toBeLessThanOrEqual(CENSUS_TOTAL);
	});
});
