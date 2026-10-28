/**
 * THE RUN FILES' CONFIG-FREE CORE (terminal installer phase 4, 2026-10-12) —
 * everything run_files.ts does that needs NO private dir, NO server state and NO
 * engine configuration: the plan/state file shapes and codecs, the atomic
 * writer, the run lock, the hash, the redaction. Every function takes its
 * directory EXPLICITLY.
 *
 * WHY A SPLIT. The production route's ROOT process (host/host_executor.ts) keeps
 * its own plan + state under /var/lib/dedalo-install/<instance>/ and must never
 * load src/config/config.ts, pg_exec or server_state (they would freeze a
 * configuration for the wrong private dir and run psql as root — critique A3).
 * run_files.ts — the engine side — re-exports this module and adds the
 * private-dir defaults and the server-state reads.
 *
 * Imports: node built-ins, the error class, the version, install_plan.ts (pure).
 * Gates: install_run_files_secret_tripwire, install_executor_native, the host
 * privilege gate (package C).
 */

import { createHash } from 'node:crypto';
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { DedaloError } from '../errors/dedalo_error.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../update/version.ts';
import type { HostCreated, HostPreflight } from './host/state_types.ts';
import type { InstallAnswers, InstallPlan, StepId } from './install_plan.ts';
import { PLAIN_ANSWER_KEYS } from './install_plan.ts';
import type { OntologyInstallRequest, OntologySourceView } from './ontology_choice.ts';

export const PLAN_FILE = 'install.plan.json';
export const STATE_FILE = 'install.state.json';
export const LOCK_FILE = 'install.lock';
export const PLAN_SCHEMA = 'dedalo.install.plan/1';
export const STATE_SCHEMA = 'dedalo.install.state/1';

export type SecretKey = 'db_password' | 'mysql_password' | 'smtp_pass' | 'root_password';
export const SECRET_KEYS: readonly SecretKey[] = Object.freeze([
	'db_password',
	'mysql_password',
	'smtp_pass',
	'root_password',
]);
export type Secrets = Partial<Record<SecretKey, string>>;

/**
 * The .env keys that hold a secret (never recorded in the plan file's
 * env_entries) — and the secret each carries back on a resume.
 */
export const ENV_SECRET_KEYS: Readonly<Record<string, SecretKey | null>> = Object.freeze({
	DB_PASSWORD: 'db_password',
	DEDALO_DIFFUSION_DB_PASSWORD: 'mysql_password',
	DEDALO_SMTP_PASS: 'smtp_pass',
	DEDALO_SALT_STRING: null,
});

// ── the plan file ────────────────────────────────────────────────────────────

/** One ontology item as the plan file records it: no temp path, a content hash instead. */
export interface PlannedOntologyItem {
	tld: string;
	origin: string;
	typology_id: number | string | null;
	dependencies: unknown;
	/** sha256 of the vendored/local file (null for a server download, fetched at stage time). */
	sha256: string | null;
}

export interface PlannedOntologyRequest {
	source: OntologySourceView;
	items: PlannedOntologyItem[];
	matrix_dd: { origin: string; sha256: string | null } | null;
}

export interface PlanFile {
	schema: typeof PLAN_SCHEMA;
	plan_hash: string;
	engine_version: string;
	created_at: string;
	answers: Partial<InstallAnswers>;
	secrets_supplied: Record<SecretKey, boolean>;
	steps: StepId[];
	hierarchies: string[];
	ontology_request: PlannedOntologyRequest | null;
	active_ontology_tlds: string[];
	env_keys: string[];
	/** The NON-secret .env entries the plan renders — persist_config's verify compares these. */
	env_entries: { key: string; value: string }[];
	notes: string[];
	warnings: string[];
	suggestions: string[];
}

/** JSON with object keys sorted at every level (the hash input). */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
	}
	return JSON.stringify(value ?? null);
}

/** sha256 over every field but `created_at` and `plan_hash`. */
export function planHash(
	plan: Omit<PlanFile, 'plan_hash' | 'created_at'> & Partial<PlanFile>,
): string {
	const { plan_hash: _hash, created_at: _created, ...hashed } = plan;
	return `sha256:${createHash('sha256').update(canonicalJson(hashed)).digest('hex')}`;
}

/** sha256 of a local file, or null when it cannot be read (a URL, a vanished temp file). */
function fileSha256(path: string): string | null {
	try {
		return createHash('sha256').update(readFileSync(path)).digest('hex');
	} catch {
		return null;
	}
}

/**
 * The ontology request as the plan file records it — compared on a resume by
 * (tld, origin, typology, dependencies, content hash), NEVER by `file`: a local
 * archive is extracted into a fresh temp dir on every run.
 */
export function plannedOntologyRequest(
	request: OntologyInstallRequest | null,
): PlannedOntologyRequest | null {
	if (request === null) return null;
	const hashOf = (origin: string, file: string) => (origin === 'server' ? null : fileSha256(file));
	return {
		source: request.source,
		items: request.items.map((item) => ({
			tld: item.tld,
			origin: item.origin,
			typology_id: item.typology_id,
			dependencies: item.dependencies,
			sha256: hashOf(item.origin, item.file),
		})),
		matrix_dd:
			request.matrixDd === null
				? null
				: {
						origin: request.matrixDd.origin,
						sha256: hashOf(request.matrixDd.origin, request.matrixDd.file),
					},
	};
}

/** The plain answers only — built from the allow-list, never by deleting from a copy. */
export function plainAnswers(answers: InstallAnswers): Partial<InstallAnswers> {
	const plain: Record<string, unknown> = {};
	for (const key of PLAIN_ANSWER_KEYS) plain[key] = answers[key];
	return plain as Partial<InstallAnswers>;
}

/** THE ONE plan-file constructor. */
export function buildPlanFile(plan: InstallPlan, secretsSupplied: Secrets): PlanFile {
	const body: Omit<PlanFile, 'plan_hash' | 'created_at'> = {
		schema: PLAN_SCHEMA,
		engine_version: formatVersion(DEDALO_DATA_VERSION),
		answers: plainAnswers(plan.answers),
		secrets_supplied: {
			db_password: (secretsSupplied.db_password ?? '') !== '',
			mysql_password: (secretsSupplied.mysql_password ?? '') !== '',
			smtp_pass: (secretsSupplied.smtp_pass ?? '') !== '',
			root_password: (secretsSupplied.root_password ?? '') !== '',
		},
		steps: [...plan.steps],
		hierarchies: [...plan.hierarchies],
		ontology_request: plannedOntologyRequest(plan.ontologyRequest),
		active_ontology_tlds: [...plan.activeOntologyTlds],
		env_keys: [...plan.envKeys],
		env_entries: plan.env
			.flatMap((section) => section.entries)
			.filter((entry) => !Object.hasOwn(ENV_SECRET_KEYS, entry.key))
			.map((entry) => ({ key: entry.key, value: entry.value })),
		notes: [...plan.notes],
		warnings: [...plan.warnings],
		suggestions: [...plan.suggestions],
	};
	return { ...body, plan_hash: planHash(body), created_at: new Date().toISOString() };
}

/**
 * The fields a re-resolved catalog decides — what a resume compares when it had
 * to resolve the ontology source again (env_entries are left out: they also
 * depend on the prior .env, which this install may already have written).
 */
export function ontologyDecisions(plan: PlanFile): unknown {
	return {
		steps: plan.steps,
		hierarchies: plan.hierarchies,
		ontology_request: plan.ontology_request,
		active_ontology_tlds: plan.active_ontology_tlds,
	};
}

/**
 * The plain answer keys whose values differ between two answer sets — only the
 * keys the operator SUPPLIED (`suppliedKeys`) when given: an answer left out of
 * a resume's command line is not "different", its normalized default is not
 * the operator's word.
 */
export function answerDifferences(
	saved: Partial<InstallAnswers>,
	given: InstallAnswers,
	suppliedKeys?: readonly string[],
): string[] {
	const now = plainAnswers(given);
	return PLAIN_ANSWER_KEYS.filter(
		(key) =>
			(suppliedKeys === undefined || suppliedKeys.includes(key)) &&
			canonicalJson(saved[key] ?? null) !== canonicalJson(now[key] ?? null),
	);
}

// ── the state file ───────────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'done' | 'failed';
export type RunMode = 'fresh' | 'resume' | 'abort';

export interface StepRecord {
	status: StepStatus;
	attempts: number;
	started_at: string | null;
	finished_at: string | null;
	verify: { ok: boolean; detail: string; at: string } | null;
	message: string | null;
	warnings: string[];
	error: { code: string; message: string } | null;
	/**
	 * What the step TOLD the operator (a host step's to-do: the firewall, the
	 * modules, the outside check) — kept so the closing To-do of a run that
	 * completes the install through --resume lists every step's, not only the
	 * ones that ran in that process (campaign 3b N19). Absent: none.
	 */
	told?: string[];
}

export interface RunRecord {
	mode: RunMode;
	/** Confirmed to execute: --execute given, or the interactive Review's yes (runConfirmed — C3-63). */
	execute: boolean;
	pid: number;
	host: string;
	started_at: string;
	finished_at: string | null;
	result: 'complete' | 'failed' | 'interrupted' | 'aborted' | 'refused' | null;
}

export interface InstallPreflight {
	preexisting_extensions: string[];
	/**
	 * The `.env.bak.*` files present at the preflight — what the install did NOT
	 * create (an operator's own backups; --abort never removes them).
	 * Optional only for a state file written before 2026-10-11's fix.
	 */
	env_backups_before?: string[];
	env_existed: boolean;
	env_sha256: string | null;
	/** The prior .env already carried DEDALO_SALT_STRING (so this install generates none). */
	env_had_salt: boolean;
	sample_env_existed: boolean;
	install_status_before: string | null;
	directories_missing: string[];
	/**
	 * The media root held nothing at the preflight (or did not exist): every
	 * directory under it is this install's, so --abort prunes the empty ones
	 * (campaign 3 C3-9). Optional: absent on an older record (then only the
	 * recorded `created.media_tree` is pruned).
	 */
	media_root_empty?: boolean;
	/**
	 * The server's runtime files that existed at the preflight (the state file,
	 * the session store): what --abort leaves (C3-9) — one the install created
	 * is removed. Optional: absent on an older record.
	 */
	runtime_files_before?: string[];
	/** A HOST run's preflight (phase 4 — host/host_executor.ts); absent on an engine run. */
	host?: HostPreflight;
}

export interface InstallCreated {
	env_file: boolean;
	/** The backup holding the PRE-INSTALL .env (restored by --abort). */
	env_backup: string | null;
	/** Every .env.bak.* this install's persist runs created (secret copies --abort deletes). */
	env_backups: string[];
	sample_env: boolean;
	directories: string[];
	staging_dir: boolean;
	/** Written when the seed step STARTS (intent): from then on every object is the install's. */
	seed_started: boolean;
	seed_restored: boolean;
	salt_generated: boolean;
	salt_shown: boolean;
	/** The media tree directories check_directories created (absolute; C3-9). Optional on an older record. */
	media_tree?: string[];
	/**
	 * The fingerprint of the database's rows when the install SEALED (after its
	 * own root login): an abort of a sealed install the host attests UNSERVED
	 * proceeds only while the database still has exactly these rows (C3-11).
	 */
	sealed_fingerprint?: string | null;
	/**
	 * The developer certificate's directory (`<private>/tls`) did not exist when
	 * dev_tls_certificate first ran: everything in it is this install's, so
	 * --abort removes it. false = it was there (an earlier install's authority,
	 * which this one only renewed) and stays. Optional: absent on an older record.
	 */
	dev_tls_dir?: boolean;
	/**
	 * What a HOST run created (phase 4): the only host resources its --abort may
	 * touch. Absent on an engine run — the engine child's state stays the
	 * engine's (A13: optional, so one schema serves both processes).
	 */
	host?: HostCreated;
}

export interface InstallState {
	schema: typeof STATE_SCHEMA;
	plan_hash: string;
	install_id: string;
	outcome: 'in_progress' | 'complete' | 'aborted';
	updated_at: string;
	runs: RunRecord[];
	preflight: InstallPreflight;
	created: InstallCreated;
	steps: Record<string, StepRecord>;
}

/** A pending step record. */
export function pendingStep(): StepRecord {
	return {
		status: 'pending',
		attempts: 0,
		started_at: null,
		finished_at: null,
		verify: null,
		message: null,
		warnings: [],
		error: null,
	};
}

/** A fresh state for `plan`: every plan step pending, nothing created yet. */
export function newInstallState(plan: PlanFile, preflight: InstallPreflight): InstallState {
	return {
		schema: STATE_SCHEMA,
		plan_hash: plan.plan_hash,
		install_id: crypto.randomUUID(),
		outcome: 'in_progress',
		updated_at: new Date().toISOString(),
		runs: [],
		preflight,
		created: {
			env_file: false,
			env_backup: null,
			env_backups: [],
			sample_env: false,
			directories: [],
			staging_dir: false,
			seed_started: false,
			seed_restored: false,
			salt_generated: !preflight.env_had_salt,
			salt_shown: false,
		},
		steps: Object.fromEntries(plan.steps.map((step) => [step, pendingStep()])),
	};
}

/**
 * Was the run CONFIRMED to execute — what a run record's `execute` says
 * (campaign 3 C3-63): `--execute` on the command line, or the interactive
 * Review's yes (the Resume screen's choice). A headless run without --execute
 * runs too (on a terminal it asks its missing secrets), unconfirmed.
 */
export function runConfirmed(executeFlag: boolean, reviewed: boolean): boolean {
	return executeFlag || reviewed;
}

/** A new run record for this process. */
export function runRecord(mode: RunMode, execute: boolean): RunRecord {
	return {
		mode,
		execute,
		pid: process.pid,
		host: hostname(),
		started_at: new Date().toISOString(),
		finished_at: null,
		result: null,
	};
}

// ── atomic I/O ───────────────────────────────────────────────────────────────

/**
 * Create the run dir at 0700 — and FORCE 0700 on one that already exists (a
 * mkdir mode applies only on creation); a symlinked run dir is refused.
 * Answers whether THIS call created it.
 */
export function ensureRunDir(dir: string): boolean {
	const existed = existsSync(dir);
	if (existed && lstatSync(dir).isSymbolicLink()) {
		runFileRefusal(`${dir} is a symbolic link — the install run dir must be a real directory`);
	}
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	return !existed;
}

/**
 * Write `text` to `path` atomically: tmp + fsync + rename. The tmp is created
 * EXCLUSIVELY (a stale one is removed first, never followed — not even a
 * symlink planted there) at 0600.
 */
export function writeFileAtomic(path: string, text: string): void {
	const tmp = `${path}.tmp.${process.pid}`;
	rmSync(tmp, { force: true });
	const fd = openSync(tmp, 'wx', 0o600);
	try {
		writeSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}

export function writePlanFile(plan: PlanFile, dir: string): void {
	writeFileAtomic(join(dir, PLAN_FILE), `${JSON.stringify(plan, null, '\t')}\n`);
}

export function writeStateFile(state: InstallState, dir: string): void {
	state.updated_at = new Date().toISOString();
	writeFileAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, '\t')}\n`);
}

/**
 * A run file that cannot be used: `install.state_conflict` (the install record
 * is not in a state this run can take over). The error class only — this module
 * stays config-free.
 */
function runFileRefusal(detail: string): never {
	throw new DedaloError('install.state_conflict', { message: detail, publicMessage: detail });
}

/** A run file parsed, or null when absent; a corrupt one throws (never treated as absent). */
function readJson(path: string): unknown {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		return runFileRefusal(`${path} is not readable JSON (${(error as Error).message})`);
	}
}

export function readPlanFile(dir: string): PlanFile | null {
	const plan = readJson(join(dir, PLAN_FILE)) as PlanFile | null;
	if (plan !== null && plan.schema !== PLAN_SCHEMA) {
		runFileRefusal(`${join(dir, PLAN_FILE)}: schema is not ${PLAN_SCHEMA}`);
	}
	return plan;
}

export function readStateFile(dir: string): InstallState | null {
	const state = readJson(join(dir, STATE_FILE)) as InstallState | null;
	if (state !== null && state.schema !== STATE_SCHEMA) {
		runFileRefusal(`${join(dir, STATE_FILE)}: schema is not ${STATE_SCHEMA}`);
	}
	return state;
}

// ── the lock (a hint; the database advisory lock is the authority) ───────────

export interface LockInfo {
	pid: number;
	host: string;
	started_at: string;
	mode: RunMode;
	/**
	 * Where the holder ran (campaign 3d C3d-F3: "container or host <id>"): a
	 * container's hostname is its id, so the reclaim note says which. Absent on
	 * a lock written before it was recorded.
	 */
	place?: LockPlace;
}

/** A lock holder's kind of machine. */
export type LockPlace = 'container' | 'host';

/**
 * The files a container runtime puts in every container it starts: Docker's
 * `/.dockerenv`, Podman's `/run/.containerenv`.
 */
export const CONTAINER_MARKERS: readonly string[] = Object.freeze([
	'/.dockerenv',
	'/run/.containerenv',
]);

/** Is THIS process in a container (a runtime's marker present)? `exists` injectable for a gate. */
export function lockPlace(exists: (path: string) => boolean = existsSync): LockPlace {
	return CONTAINER_MARKERS.some((path) => exists(path)) ? 'container' : 'host';
}

/** Is `pid` a live process (on THIS host)? */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * What a reclaimed lock earns: a plain note for the EXPECTED case (an earlier,
 * interrupted run's lock — a resume after Ctrl-C meets it every time), a
 * warning only for a lock that cannot even be read (campaign 3c D9: the
 * expected case read "⚠ reclaimed stale install lock of pid 1 on <container id>").
 */
export interface LockNotes {
	note: (line: string) => void;
	warn: (line: string) => void;
}

/**
 * Take the run lock. Refuses (returns the holder) only when a LIVE process on
 * THIS host holds it; a dead pid, this very pid (a container restarted with the
 * same pid) or another host (a container's random hostname) is reclaimed and
 * said (LockNotes) — two hosts on one database are stopped by the advisory
 * lock, not by this file.
 */
export function acquireRunLock(
	mode: RunMode,
	notes: LockNotes,
	dir: string,
): { ok: true } | { ok: false; holder: LockInfo } {
	const path = join(dir, LOCK_FILE);
	const mine: LockInfo = {
		pid: process.pid,
		host: hostname(),
		started_at: new Date().toISOString(),
		mode,
		place: lockPlace(),
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		if (createLockFile(path, mine)) return { ok: true };
		const holder = readLockHolder(path);
		if (holder !== null && holderIsLive(holder, mine)) return { ok: false, holder };
		if (reclaimStaleLock(path, holder)) sayReclaimed(notes, holder, mine);
	}
	return runFileRefusal(`cannot take the install lock ${path}`);
}

/**
 * Remove a STALE lock atomically: rename it to a name only this process uses,
 * then check the renamed file is still the dead holder that was read. Two
 * processes reclaiming the same stale lock cannot both win: the loser's rename
 * either fails (already gone) or captures the WINNER's fresh lock — which it
 * puts back. Answers whether this call removed the stale lock.
 */
export function reclaimStaleLock(path: string, holder: LockInfo | null): boolean {
	const claimed = `${path}.reclaim.${process.pid}`;
	try {
		renameSync(path, claimed);
	} catch {
		return false; // someone else reclaimed (or released) it first
	}
	const captured = readLockHolder(claimed);
	if (canonicalJson(captured) === canonicalJson(holder)) {
		rmSync(claimed, { force: true });
		return true;
	}
	// Captured another process's FRESH lock: put it back, unless a third took the path.
	try {
		linkSync(claimed, path);
	} catch {
		// the path is taken again — the next createLockFile attempt sees it
	}
	rmSync(claimed, { force: true });
	return false;
}

/** Create the lock file exclusively (0600); false when it already exists. */
function createLockFile(path: string, mine: LockInfo): boolean {
	let fd: number;
	try {
		fd = openSync(path, 'wx', 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
		throw error;
	}
	try {
		writeSync(fd, `${JSON.stringify(mine)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	return true;
}

/** The lock's holder, or null when it is unreadable. */
function readLockHolder(path: string): LockInfo | null {
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
	} catch {
		return null;
	}
}

/** A holder counts only when it is ANOTHER live process on THIS host. */
function holderIsLive(holder: LockInfo, mine: LockInfo): boolean {
	return holder.host === mine.host && holder.pid !== mine.pid && pidAlive(holder.pid);
}

/**
 * The LIVE holder of the run lock in `dir` (another process on this host that
 * is still running), or null — what `--status` tells a host parent, so a
 * resume never races the child of an earlier run (campaign 3 C3-29).
 */
export function liveLockHolder(dir: string): LockInfo | null {
	const holder = readLockHolder(join(dir, LOCK_FILE));
	if (holder === null) return null;
	const me: LockInfo = {
		pid: process.pid,
		host: hostname(),
		started_at: '',
		mode: holder.mode,
	};
	return holderIsLive(holder, me) ? holder : null;
}

/** Say a reclaimed lock: a note for an earlier run's, the one warning for an unreadable lock. */
function sayReclaimed(notes: LockNotes, holder: LockInfo | null, mine: LockInfo): void {
	if (holder === null) notes.warn('reclaimed an unreadable install lock');
	else notes.note(reclaimSentence(holder, mine));
}

/**
 * The note a reclaimed lock of an earlier run earns, in plain words: on THIS
 * host its process is gone; on another (the engine child's container, named by
 * its id) it ran elsewhere — the caller stopped that container first (C3-29).
 */
export function reclaimSentence(holder: LockInfo, mine: LockInfo): string {
	const where =
		holder.host === mine.host ? `process ${holder.pid} is no longer running` : elsewhere(holder);
	return `the earlier, interrupted run's install lock was released (${where})`;
}

/** Where another machine's holder ran, by the place its lock recorded (C3d-F3). */
function elsewhere(holder: LockInfo): string {
	if (holder.place === 'container') return `it ran in container ${holder.host}`;
	if (holder.place === 'host') return `it ran on host ${holder.host}`;
	return `it ran on ${holder.host}, another machine or container`;
}

/** Release the run lock if this process holds it. */
export function releaseRunLock(dir: string): void {
	const path = join(dir, LOCK_FILE);
	try {
		const holder = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
		if (holder.pid === process.pid && holder.host === hostname()) rmSync(path, { force: true });
	} catch {
		// absent or unreadable: nothing of ours to release
	}
}

// ── secrets ──────────────────────────────────────────────────────────────────

/**
 * Replace every supplied secret value (length >= 4 — a shorter one would
 * garble ordinary text) with `***`. Applied to every string the installer
 * writes to its run files or prints.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
	let out = text;
	const values = secrets
		.filter((value): value is string => value !== undefined && value.length >= 4)
		.sort((a, b) => b.length - a.length);
	for (const value of values) out = out.split(value).join('***');
	return out;
}

/** The secrets a written .env carries back (DB_PASSWORD → db_password, …). */
export function secretsFromEnv(env: Readonly<Record<string, string>>): Secrets {
	const secrets: Secrets = {};
	for (const [key, secret] of Object.entries(ENV_SECRET_KEYS)) {
		if (secret !== null && env[key] !== undefined) secrets[secret] = env[key];
	}
	return secrets;
}

/** sha256 of a file, or null. */
export function sha256Of(path: string): string | null {
	return existsSync(path) ? fileSha256(path) : null;
}

/** File mode bits of a path (for the gates and the executor's own assertions). */
export function modeOf(path: string): number {
	return statSync(path).mode & 0o777;
}
