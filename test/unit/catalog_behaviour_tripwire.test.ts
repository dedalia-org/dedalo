/**
 * CATALOG-BEHAVIOUR TRIPWIRE — the catalog's PROSE against the ENGINE (DEC-12).
 *
 * WHAT WAS MISSING. `config_docs_tripwire` proves the three generated artifacts
 * (install/sample.env, docs/administration/configuration/config.md, docs/administration/configuration/config_db.md) are
 * byte-for-byte what `src/config/catalog/` renders — the catalog and the manual
 * cannot drift. NOTHING proved the catalog matches the CODE. So a sentence could
 * describe an engine behaviour that no function performs, and every gate stayed
 * green while the manual lied.
 *
 * THE DEFECT THAT PROVES IT (audit P0-13, closed 2026-08-30).
 * `DEDALO_BACKUP_TIME_RANGE` documented, for the whole life of the TS engine:
 * "Dédalo check in every user login if the last backup exceed this time lapse,
 * in affirmative case, it will create new one." That is v6 behaviour, inherited
 * as prose and never as code — the login path starts no backup, and nothing else
 * does either. An operator who trusted that sentence believed they had periodic
 * backups and had NONE. For a museum with one copy of its records, that single
 * false sentence is a total-loss risk, and it was invisible to every gate in the
 * tree. The prose is corrected (see the `// (!)` note at the entry in
 * src/config/catalog/ops.ts); this gate is what keeps a claim like it honest.
 *
 * THE RULE. A catalog key whose prose describes an engine BEHAVIOUR must name the
 * function that performs it, and that function must have a PRODUCTION CALLER.
 *
 * WHERE THE FUNCTION IS NAMED, AND WHY HERE. Not in the `doc` field: that string
 * is rendered straight into the operator's manual, which carries no `src/` paths
 * by precedent. The mapping therefore lives in this file, as an ENUMERATED census
 * with a reason per row — which is also the honest shape, because "this prose
 * describes a behaviour" is a JUDGEMENT that cannot be derived reliably from
 * English. See the LIMITS block at the bottom for exactly what that costs.
 *
 * Two legs:
 *   A. every listed key still exists, names a function that is DEFINED where the
 *      row says, and that function is REACHED from production code;
 *   B. a DERIVED trigger over all operator-facing prose: a key that promises an
 *      automatic/periodic action must be on the list in A or on a shrink-only
 *      waiver list with a reason. This is what catches a key added tomorrow —
 *      for the one class of claim that can be recognised mechanically.
 *
 * Measured 2026-08-30: 267 operator-facing keys, 9 of them match the leg-B
 * pattern, 8 listed as claims + 1 waived.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { CONFIG_CATALOG, isOperatorFacing } from '../../src/config/catalog/index.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * One row of the enumerated census: a catalog key, the ONE function that makes
 * its promise true, and why the row exists.
 */
interface BehaviourClaim {
	/** The catalog key. */
	readonly key: string;
	/** What the prose promises the engine DOES — the sentence under gate, in one line. */
	readonly claim: string;
	/** The identifier that performs it. */
	readonly performedBy: string;
	/** Repo-relative file that DEFINES that identifier. */
	readonly definedIn: string;
	/**
	 * Only for a performer whose production wiring is INSIDE its own module (a
	 * module-level derivation, not a function anyone calls across a file
	 * boundary): the exported symbol from the SAME file that carries the result
	 * out, which must itself be referenced from another production file. Without
	 * this escape the gate would fire on a legitimate path — an outage, not a
	 * gate — but it is deliberately a named, per-row exception, never the default.
	 */
	readonly wiredInto?: string;
	/**
	 * A phrase the prose MUST keep. Used where the honest text is a NEGATIVE
	 * ("this schedules nothing"): deleting it is how the fiction would come back,
	 * and a negative cannot be gated by pointing at a function.
	 */
	readonly proseAnchor?: RegExp;
}

/**
 * THE CENSUS — enumerated, shrink-only (see COVERAGE_FLOOR).
 *
 * Every row was verified by reading the code on 2026-08-30. A row is a promise
 * that this key's prose is backed by code; removing one is removing a guarantee,
 * and is legitimate ONLY when the key leaves the catalog or its prose stops
 * claiming a behaviour — with the reason recorded here in the same change.
 */
const BEHAVIOUR_CLAIMS: readonly BehaviourClaim[] = [
	{
		key: 'DEDALO_BACKUP_TIME_RANGE',
		claim: 'a code update is REFUSED when the newest database dump is older than this many hours',
		// `requireFreshBackup` since OPS-1 (2026-09-30): the refusal became its own
		// async door (the verdict is a full archive read); `backupFreshness` is the
		// verdict it applies, and code_update.ts calls the refusal, not the verdict.
		performedBy: 'requireFreshBackup',
		definedIn: 'src/core/update/preconditions.ts',
		// The negative half is the one that matters here: the old prose promised a
		// login-triggered backup. If someone re-introduces a scheduling claim they
		// must first delete this sentence, and that turns this gate red.
		proseAnchor: /schedules NOTHING/,
	},
	{
		key: 'DEDALO_BACKUP_DIR',
		claim: 'the maintenance backup tool writes its database dumps into this directory',
		performedBy: 'initBackupSequence',
		definedIn: 'src/core/area_maintenance/backup.ts',
	},
	{
		key: 'DEDALO_GEOIP_AUTO_UPDATE',
		claim: 'the server downloads the IP-to-Country database on first use and refreshes it monthly',
		performedBy: 'ensureGeoipDb',
		definedIn: 'src/core/geoip/ensure.ts',
	},
	{
		key: 'DEDALO_SLOW_REQUEST_MS',
		claim: 'a request slower than this is warn-logged with its duration and counted',
		performedBy: 'logApiAccess',
		definedIn: 'src/core/api/access_log.ts',
	},
	{
		key: 'DEDALO_ERROR_REPORT_RETENTION_DAYS',
		claim: 'received error reports older than this many days are pruned',
		performedBy: 'insertErrorReport',
		definedIn: 'src/core/error_report/store.ts',
	},
	{
		key: 'DEDALO_SINGLE_SESSION',
		claim: 'a successful login evicts every other session that user holds',
		performedBy: 'endUserSessions',
		definedIn: 'src/core/security/session_media.ts',
	},
	{
		key: 'LOGIN_MAX_ATTEMPTS',
		claim: 'further logins from the same address are refused once the limit is reached',
		performedBy: 'isThrottled',
		definedIn: 'src/core/security/session_store.ts',
	},
	{
		key: 'LOGIN_ACCOUNT_MAX_ATTEMPTS',
		claim: 'the account is locked once this many failures accumulate from any address',
		performedBy: 'isThrottled',
		definedIn: 'src/core/security/session_store.ts',
	},
	{
		key: 'DEDALO_MEDIA_PROCESSES_DIR',
		claim: 'terminal media-job process files are pruned automatically',
		performedBy: 'reconcileProcessFiles',
		definedIn: 'src/core/media/jobs.ts',
	},
	{
		key: 'DEDALO_CODE_FILES_DIR',
		claim: 'the directory is created at boot on a code server, recursively, at mode 0750',
		performedBy: 'ensureCodeFilesDirAtBoot',
		definedIn: 'src/core/update/code_files_dir.ts',
	},
	{
		key: 'IS_A_CODE_SERVER',
		claim: 'this install serves release archives to other installations',
		performedBy: 'serveCodeReleaseRequest',
		definedIn: 'src/core/update/code_serving.ts',
	},
	{
		// PERF-11: was `runWithoutStatementTimeout` ("exempt automatically") — that
		// helper is now one consumer of the scope named here.
		key: 'DB_STATEMENT_TIMEOUT_MS',
		claim:
			'maintenance does not run under this ceiling: the maintenance-area actions and the data-update engine run on a separate, unbounded maintenance pool',
		performedBy: 'withUnboundedStatements',
		definedIn: 'src/core/db/postgres.ts',
	},
	{
		key: 'ONTOLOGY_SERVERS',
		claim: 'every origin named here is added to the connect-src Content-Security-Policy',
		performedBy: 'deriveUpdateMasterOrigins',
		definedIn: 'src/core/api/static_asset.ts',
		// Module-level derivation: the result feeds CONNECT_SRC -> APP_CSP ->
		// SECURITY_HEADERS in the same file, and SECURITY_HEADERS is what server.ts
		// puts on responses. Nobody CALLS the deriver across a file boundary, so the
		// plain caller rule would fire on code that is demonstrably live.
		wiredInto: 'SECURITY_HEADERS',
	},
	{
		key: 'DEDALO_RECONCILE_SCHEDULER_ENABLED',
		claim:
			'the server runs the boot-class cross-store reconciles once after it listens and the interval-class ones on their period',
		performedBy: 'startReconcileScheduler',
		definedIn: 'src/core/reconcile/scheduler.ts',
	},
	{
		key: 'DEDALO_RETENTION_SCHEDULER_ENABLED',
		claim:
			'the server applies the configured retention windows once shortly after boot and daily thereafter',
		performedBy: 'startRetentionScheduler',
		definedIn: 'src/core/retention/scheduler.ts',
	},
	{
		key: 'DEDALO_EXPORT_ARTIFACTS_TTL_HOURS',
		claim:
			'the export directory is swept when the engine starts and every hour: expired exports deleted, orphaned running ones marked interrupted',
		performedBy: 'startExportArtifactSweeper',
		definedIn: 'tools/tool_export/server/artifact_store.ts',
	},
	{
		key: 'DEDALO_UPLOAD_SERVICE_CHUNK_FILES',
		claim: 'a file larger than this is segmented into chunks for upload',
		performedBy: 'create_transfer',
		// client/ IS production since the cutover (it is the TS-owned primary client
		// source), so a claim performed there is gated exactly like a src/ one.
		definedIn: 'client/dedalo/core/services/service_upload/js/upload_transport.js',
	},
];

/**
 * SHRINK-ONLY RATCHET. The census may GROW freely (more gated claims is strictly
 * better). It may only shrink when a key genuinely leaves the catalog or stops
 * claiming a behaviour — which means lowering this number in the same change,
 * with the reason in the diff. Measured 2026-08-30: 14 rows; 15 with the
 * reconcile scheduler (S-10); 16 with the export artifacts sweeper (2026-09-23).
 */
const COVERAGE_FLOOR = 16;

/**
 * LEG B trigger: prose that promises an action the engine takes BY ITSELF —
 * on a schedule, or without being asked. Deliberately narrow: it is the one
 * shape that can be recognised in English without guessing, and it is the shape
 * the DEDALO_BACKUP_TIME_RANGE fiction had ("check in every user login … it will
 * create new one" — matched by `every user login`).
 */
const SCHEDULE_CLAIM_RE =
	/\b(automatically|periodically|nightly|monthly|weekly|daily|every user login|on each login|at every login|scheduled)\b/i;

/**
 * Keys whose leg-B match is NOT a behaviour claim. Enumerated, shrink-only, a
 * reason each — a waiver list that grows without argument is how a census dies.
 */
const NOT_A_BEHAVIOUR_CLAIM: readonly { readonly key: string; readonly reason: string }[] = [
	{
		key: 'DEDALO_GEOIP_DB_URL',
		reason:
			'"monthly" here describes the DEFAULT VALUE (the month token in the DB-IP URL), not an action: the download it feeds is the behaviour of DEDALO_GEOIP_AUTO_UPDATE, which IS a listed claim (ensureGeoipDb).',
	},
];

// ---------------------------------------------------------------------------
// The production scan. DERIVED: walk the production trees, never a hand list of
// files — an enumerated file list would rot the day a subsystem moves.
// ---------------------------------------------------------------------------

/** Production roots. test/ and scripts/ are EXCLUDED on purpose: a function whose
 *  only callers are tests is exactly the "documented but not performed" defect. */
const PRODUCTION_ROOTS = ['src', 'client', 'tools'] as const;
const CODE_EXTENSIONS = new Set(['.ts', '.js', '.mjs']);
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'vendor', '.git', 'test', 'tests']);

function collectProductionFiles(): string[] {
	const found: string[] = [];
	const walk = (absolute: string): void => {
		for (const name of readdirSync(absolute)) {
			if (SKIP_DIRECTORIES.has(name)) continue;
			const child = join(absolute, name);
			if (statSync(child).isDirectory()) {
				walk(child);
				continue;
			}
			if (!CODE_EXTENSIONS.has(extname(name))) continue;
			// A *.test.ts parked outside test/ is still a test, not production.
			if (name.includes('.test.')) continue;
			found.push(child);
		}
	};
	for (const root of PRODUCTION_ROOTS) walk(join(REPO_ROOT, root));
	return found;
}

/**
 * Strip comments so a MENTION cannot pass as a call. This is the difference
 * between "the code does it" and "a comment says it does": the fiction this gate
 * exists for was pure prose, and a header sentence naming the function would have
 * satisfied a naive substring scan.
 *
 * The `//` rule ignores a `//` preceded by `:` so an `https://…` inside a string
 * does not swallow the rest of the line (which could have hidden a real
 * reference — a false RED, i.e. an outage). Block comments are removed outright.
 * Honest limit: this is a lexer's job done with regexes; a `//` inside a string
 * literal that is not part of a URL still truncates that line. It can only ever
 * LOSE a reference, never invent one, so the failure direction is a red gate that
 * a human reads — never a silent pass.
 */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const productionFiles = collectProductionFiles();
const productionCode = new Map<string, string>(
	productionFiles.map((absolute) => [
		relative(REPO_ROOT, absolute),
		stripComments(readFileSync(absolute, 'utf8')),
	]),
);

/** Production files (other than `exclude`) whose CODE references `identifier`. */
function referencingFiles(identifier: string, exclude: string): string[] {
	const word = new RegExp(`\\b${identifier}\\b`);
	const hits: string[] = [];
	for (const [path, code] of productionCode) {
		if (path === exclude) continue;
		if (word.test(code)) hits.push(path);
	}
	return hits.sort();
}

describe('catalog behaviour: documented behaviour is performed by live code', () => {
	test('the production scan actually found the tree', () => {
		// A broken walk would make every "has a caller" assertion vacuously… red,
		// but a broken EXCLUDE list could make them vacuously green. Measured
		// 2026-08-30: 1484 files across src/ client/ tools/.
		expect(productionCode.size).toBeGreaterThan(800);
		expect(productionCode.has('src/server.ts')).toBe(true);
	});

	test('every listed key is still an operator-facing catalog key', () => {
		// A row for a key that no longer exists gates nothing while looking like it
		// does — the worst state a census can be in.
		const stale = BEHAVIOUR_CLAIMS.filter(({ key }) => {
			const entry = CONFIG_CATALOG[key];
			return entry === undefined || !isOperatorFacing(entry);
		}).map(({ key }) => key);
		expect(stale.sort()).toEqual([]);
	});

	test('the census has not shrunk', () => {
		expect(BEHAVIOUR_CLAIMS.length).toBeGreaterThanOrEqual(COVERAGE_FLOOR);
		// No duplicate rows: two rows for one key would inflate the floor without
		// gating anything more.
		expect(new Set(BEHAVIOUR_CLAIMS.map((c) => c.key)).size).toBe(BEHAVIOUR_CLAIMS.length);
	});

	test('every named performer is DEFINED where the census says', () => {
		const missing = BEHAVIOUR_CLAIMS.filter(({ performedBy, definedIn }) => {
			const code = productionCode.get(definedIn);
			if (code === undefined) return true;
			return !new RegExp(`(function|const|let|class)\\s+${performedBy}\\b`).test(code);
		}).map(
			({ key, performedBy, definedIn }) => `${key}: ${performedBy} not defined in ${definedIn}`,
		);

		// Moving a function is fine; leaving the census pointing at where it USED to
		// be is how a gate quietly stops proving anything.
		expect(missing.sort()).toEqual([]);
	});

	test('every named performer is REACHED from production code', () => {
		const orphaned: string[] = [];
		for (const claim of BEHAVIOUR_CLAIMS) {
			const direct = referencingFiles(claim.performedBy, claim.definedIn);
			if (direct.length > 0) continue;
			// Second hop, only when the row declared one (see `wiredInto`).
			const wired =
				claim.wiredInto === undefined ? [] : referencingFiles(claim.wiredInto, claim.definedIn);
			if (wired.length > 0) continue;
			orphaned.push(
				`${claim.key}: ${claim.performedBy} (${claim.definedIn}) has no production caller — ` +
					`the manual promises "${claim.claim}"`,
			);
		}

		// THE ASSERTION THIS FILE EXISTS FOR. A key whose prose describes an engine
		// behaviour, pointed at code that nothing outside the tests ever runs, is
		// the DEDALO_BACKUP_TIME_RANGE defect in its general form.
		expect(orphaned.sort()).toEqual([]);
	});

	test('prose anchors survive (a claim retracted in words stays retracted)', () => {
		const lost = BEHAVIOUR_CLAIMS.filter(
			(claim) =>
				claim.proseAnchor !== undefined &&
				!claim.proseAnchor.test(CONFIG_CATALOG[claim.key]?.doc ?? ''),
		).map((claim) => `${claim.key}: prose no longer matches ${String(claim.proseAnchor)}`);

		// DEDALO_BACKUP_TIME_RANGE's honest sentence is a NEGATIVE ("It schedules
		// NOTHING"). No function can stand behind a negative, so the gate holds the
		// words: rewriting them is a deliberate act that has to pass here first.
		expect(lost.sort()).toEqual([]);
	});

	test('a key that promises an automatic action is listed or waived (DERIVED)', () => {
		const listed = new Set(BEHAVIOUR_CLAIMS.map((c) => c.key));
		const waived = new Set(NOT_A_BEHAVIOUR_CLAIM.map((w) => w.key));

		const unaccounted = Object.entries(CONFIG_CATALOG)
			.filter(([, entry]) => isOperatorFacing(entry))
			.filter(([, entry]) => SCHEDULE_CLAIM_RE.test(entry.doc))
			.filter(([key]) => !listed.has(key) && !waived.has(key))
			.map(([key]) => key);

		// This is the leg that catches a NEW key: prose promising the engine acts on
		// its own must either name the code that acts, or say in writing why the
		// wording is not a promise. Ten keys match the pattern today (measured
		// 2026-09-05) — nine claims and one waiver.
		expect(unaccounted.sort()).toEqual([]);
	});

	test('every waiver is for a key that still exists and still matches', () => {
		const rotten = NOT_A_BEHAVIOUR_CLAIM.filter(({ key }) => {
			const entry = CONFIG_CATALOG[key];
			return entry === undefined || !isOperatorFacing(entry) || !SCHEDULE_CLAIM_RE.test(entry.doc);
		}).map(({ key }) => key);

		// A waiver that no longer applies is a hole nobody can see. Shrink-only means
		// the list gets SMALLER as prose is fixed — so a stale row must be deleted,
		// not left to age.
		expect(rotten.sort()).toEqual([]);
		expect(NOT_A_BEHAVIOUR_CLAIM.every((w) => w.reason.trim().length > 40)).toBe(true);
	});
});

/**
 * WHAT THIS GATE DOES NOT PROVE — stated plainly, because implying more coverage
 * than exists is the same class of defect it was written to close.
 *
 *  1. It does not prove the function does what the sentence SAYS. It proves the
 *     named code exists and is reachable from production. `requireFreshBackup` could
 *     be rewritten to always return "fresh" and this file would stay green — the
 *     behaviour itself is gated by its own tests, not here.
 *  2. Leg A is a JUDGEMENT, enumerated by hand. A key added tomorrow whose prose
 *     claims a behaviour outside the leg-B pattern is NOT caught until somebody
 *     adds a row. There is no way around that: "this English describes an engine
 *     action" is not derivable, and a pattern loose enough to catch everything
 *     would fire on the 267-key catalog wholesale — a gate nobody could keep.
 *  3. Leg B recognises ONE class of claim (an automatic/periodic action). Prose
 *     that says "the server rejects X" or "the value is applied to Y" is not
 *     matched.
 *  4. "Reached from production" is a static, comment-stripped identifier match,
 *     not a call graph. A reference inside dead-but-shipped code counts as a
 *     caller; a call assembled dynamically from a string does not.
 *  5. Nothing here reads the generated artifacts — that is config_docs_tripwire's
 *     job, and the two gates are deliberately disjoint: one holds the DOCS to the
 *     catalog, this one holds the CATALOG to the code.
 */
