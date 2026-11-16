/**
 * THE AI SPEND LEDGER — every model spend is reserved against the caller's
 * per-day LIMITS before the provider is touched (closure Step 3, TOOLS-4;
 * owner decisions 2026-09-30 and 2026-10-12; WC-2026-10-01-ai-spend-budget).
 *
 * WHAT WAS WRONG. An authenticated user could spend without bound: the agent
 * loop (up to MAX_ITERATIONS provider turns per call), the generative RAG
 * `ask`, the retrieval query embeddings and the identify vision calls. A grant
 * says WHO may spend; nothing said HOW MUCH, so one session could run an
 * installation's model bill (or its local GPU) into the ground.
 *
 * THE LEDGER IS STANDARD SCHEMA ON MASTER-DEFINED TIPOS (the Dédalo way — no
 * bespoke table, and the engine owns no ontology): section `dd660` "AI usage"
 * (under dd207, in the matrix table its ontology names — the SQL below always
 * resolves it, never spells it), ONE record per (user, UTC day): the
 * user (`dd663`, a dd128 locator), the day (`dd664`, a component_date storing
 * the dd_date `{start:{year,month,day,time}}`), and four counters (`dd665`
 * runs, `dd666` tokens, `dd667` query embeddings, `dd668` vision calls). It is
 * written through the engine's own doors — `createSectionRecord` for the day's
 * birth, `persistRecordKeys` (the component-key chokepoint: stamped, observed,
 * evented) for every counter move — so an administrator reads and corrects it
 * like any other section, and it is DB state: no cache clear, no restart, no
 * second process resets it.
 *
 * THE LIMITS ARE DATA, edited where users and profiles are edited (the
 * per-user daily env keys are REMOVED, 2026-10-12, WC-2026-10-12-ddengine-removed):
 *   per USER    (dd128, group dd647): dd692 runs, dd693 tokens, dd694 embeds, dd695 vision;
 *   per PROFILE (dd234, group dd649): dd696 runs, dd697 tokens, dd698 embeds, dd699 vision.
 * Each kind resolves ON ITS OWN: the user's value when it is set (non-empty),
 * else the value of the user's profile (the dd1725 assignment), else 0. An
 * explicit 0 REFUSES (it is a value, not "unset"); there is no unlimited value.
 * Read per reservation, inside its transaction — DB state, never a
 * cross-request cache: an administrator's change takes effect at the next spend.
 *
 * THE PROTOCOL, per spend:
 *   1. `reserveAiSpend(principal, {door, runs?, tokens?, embeds?, vision?})`
 *      BEFORE the provider (before an SSE stream opens): in ONE transaction,
 *      under the node lock of (user, day) — which serializes the find-or-create
 *      a `FOR UPDATE` alone cannot (there is no row to lock before the birth) —
 *      the day's row is read `FOR UPDATE`, the limits are read, every requested
 *      kind is checked (`used + requested > limit` refuses), and the request is
 *      CHARGED. Refusal: `ai.budget_exhausted` (429, details budget_kind / limit
 *      / window_resets_at). A failure to read the ledger or the limits, or to
 *      write the ledger, is `ai.budget_unavailable` (503) — FAIL CLOSED, never
 *      an unmetered spend.
 *   2. `settle(usage)` once the provider answered (in `finally`): the token
 *      reservation is replaced by the REPORTED usage. A missing usage keeps the
 *      FULL reservation charged — never settle-to-zero.
 *   3. `release()` only when the provider was provably never called (a
 *      grounding miss, an egress refusal): the whole reservation is refunded.
 * Counts (runs, embeds, vision) are final at reserve; only tokens settle.
 *
 * NOBODY IS EXEMPT — root and global admins included: spend is a resource, and
 * a resource has an owner and a limit. The SYSTEM principal (the RAG indexer,
 * embed_source.ts) never reaches a metered door: indexing is the
 * installation's own work, not a user's spend.
 *
 * Gate: test/unit/ai_spend_budget_native.test.ts.
 */

import { ddDateToSeconds } from '../concepts/dd_date_time.ts';
import { acquireNodeLock, sql, withTransaction } from '../db/postgres.ts';
import { DedaloError, isDedaloError, logError, toDedaloError } from '../errors/index.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../ontology/resolver.ts';
import { getTldFromTipo } from '../ontology/tld.ts';
import { auditUserLocator, createSectionRecord } from '../section/record/create_record.ts';
import { persistRecordKeys, type SavePathItem } from '../section_record/record_write.ts';
import { PROFILES_SECTION, type Principal, resolveProfileId } from './permissions.ts';

/** The four spend kinds. */
export type AiSpendKind = 'runs' | 'tokens' | 'embeds' | 'vision';
const KINDS: readonly AiSpendKind[] = Object.freeze(['runs', 'tokens', 'embeds', 'vision']);

/** The ledger's ontology coordinates (one tipo per counter kind). */
export interface AiSpendLedger extends Record<AiSpendKind, string> {
	section: string;
	user: string;
	day: string;
}

/** The ledger: master ontology section dd660 "AI usage". */
export const AI_SPEND_LEDGER: Readonly<AiSpendLedger> = Object.freeze({
	section: 'dd660',
	user: 'dd663',
	day: 'dd664',
	runs: 'dd665',
	tokens: 'dd666',
	embeds: 'dd667',
	vision: 'dd668',
});

/** Where one level of limits lives: a section and one component_number per kind. */
export interface AiSpendLimitLevel extends Record<AiSpendKind, string> {
	section: string;
}

/** The two limit levels, user first. */
export interface AiSpendLimitTipos {
	user: AiSpendLimitLevel;
	profile: AiSpendLimitLevel;
}

/** The limits: master components on the users (dd128) and profiles (dd234) sections. */
export const AI_SPEND_LIMITS: Readonly<AiSpendLimitTipos> = Object.freeze({
	user: Object.freeze({
		section: 'dd128',
		runs: 'dd692',
		tokens: 'dd693',
		embeds: 'dd694',
		vision: 'dd695',
	}),
	profile: Object.freeze({
		section: PROFILES_SECTION,
		runs: 'dd696',
		tokens: 'dd697',
		embeds: 'dd698',
		vision: 'dd699',
	}),
});

/** The counters of one (user, day). */
export type AiSpendCounters = Record<AiSpendKind, number>;

/** Where a kind's effective limit came from (`none` = neither level set it ⇒ 0). */
export type AiSpendLimitSource = 'user' | 'profile' | 'none';

/** One kind's effective limit. */
export interface AiSpendLimit {
	limit: number;
	source: AiSpendLimitSource;
}

/** The effective limits of a principal, per kind (each kind resolved on its own). */
export type AiSpendLimits = Record<AiSpendKind, AiSpendLimit>;

/** What one spend asks for. `door` names the caller in logs and refusals. */
export interface AiSpendRequest {
	door: string;
	runs?: number;
	tokens?: number;
	embeds?: number;
	vision?: number;
}

/** Usage the provider reported; `null` (or no finite `tokens`) = not reported. */
export interface AiSpendUsage {
	tokens?: number;
}

export interface AiSpendReservation {
	/**
	 * Replace the token reservation by the reported usage; null keeps the
	 * reservation. Idempotent. NEVER THROWS: a ledger failure here is logged and
	 * leaves the reservation charged (the request it settles already happened).
	 */
	settle(usage: AiSpendUsage | null): Promise<void>;
	/** Refund the whole reservation — ONLY when the provider was never called. Idempotent; never throws. */
	release(): Promise<void>;
}

/**
 * The SCRATCH SEAM (tests only): a ledger / limit set that differs from the
 * shipped one ONLY by tipos under a `zz` scratch TLD — the way a gate proves
 * the fail-closed path without touching master nodes. Any other tipo is refused
 * (`internal.invariant`), so the writes stay HARD-BOUND to the shipped ledger
 * section or a scratch one: no caller can aim them at a dd128 component (the
 * dd128 write census classifies this module `not-dd128` on that fact).
 */
export interface AiSpendSeam {
	ledger?: Readonly<AiSpendLedger>;
	limits?: Readonly<AiSpendLimitTipos>;
}

/** Per-call options. */
export interface AiSpendOptions extends AiSpendSeam {
	/** Test hook: runs after the day's row was read under the lock, before the charge. */
	afterRead?: () => Promise<void>;
	/** The instant (tests); defaults to now. */
	now?: Date;
}

/** The UTC day a spend is charged to (`YYYY-MM-DD`). */
export function spendDay(now: Date): string {
	return now.toISOString().slice(0, 10);
}

/** The next UTC midnight — when the day's counters reset. */
export function budgetResetsAt(now: Date): string {
	const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
	return next.toISOString();
}

/** The UTC day as the dd_date a component_date stores (`time` derived, as the save door does). */
export function spendDayDate(now: Date): {
	year: number;
	month: number;
	day: number;
	time: number;
} {
	const date = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
	return { ...date, time: ddDateToSeconds(date) };
}

/** A requested amount: a non-negative integer, else 0. */
function amount(value: number | undefined): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

function requested(request: AiSpendRequest): AiSpendCounters {
	return {
		runs: amount(request.runs),
		tokens: amount(request.tokens),
		embeds: amount(request.embeds),
		vision: amount(request.vision),
	};
}

/** FAIL CLOSED: anything that is not this module's own verdict becomes `ai.budget_unavailable`. */
function unavailable(error: unknown, door: string): never {
	if (
		isDedaloError(error) &&
		(error.code === 'ai.budget_exhausted' || error.code === 'ai.budget_unavailable')
	) {
		throw error;
	}
	throw new DedaloError('ai.budget_unavailable', {
		cause: error,
		message: `ai_spend: the ledger or the limits could not be used for ${door}`,
		coordinates: { door },
	});
}

/** Every tipo of `seam` equals the shipped one or sits under a `zz` scratch TLD. */
function assertScratchOnly(
	shipped: Readonly<AiSpendLedger> | Readonly<AiSpendLimitLevel>,
	seam: Readonly<AiSpendLedger> | Readonly<AiSpendLimitLevel>,
	what: string,
): void {
	const shippedTipos: Readonly<Record<string, string>> = { ...shipped };
	for (const [field, tipo] of Object.entries(seam)) {
		if (tipo === shippedTipos[field]) continue;
		if (getTldFromTipo(tipo)?.startsWith('zz') === true) continue;
		throw new DedaloError('internal.invariant', {
			message: `ai_spend: the ${what} seam may only name zz scratch tipos ('${field}' = '${tipo}')`,
			coordinates: { field, tipo },
		});
	}
}

function seamLedger(options: AiSpendSeam): Readonly<AiSpendLedger> {
	if (options.ledger === undefined) return AI_SPEND_LEDGER;
	assertScratchOnly(AI_SPEND_LEDGER, options.ledger, 'ledger');
	return options.ledger;
}

function seamLimits(options: AiSpendSeam): Readonly<AiSpendLimitTipos> {
	if (options.limits === undefined) return AI_SPEND_LIMITS;
	assertScratchOnly(AI_SPEND_LIMITS.user, options.limits.user, 'user limits');
	assertScratchOnly(AI_SPEND_LIMITS.profile, options.limits.profile, 'profile limits');
	return options.limits;
}

const isMatrixTable = (table: string | null): table is string =>
	table !== null && /^matrix[a-z_]*$/.test(table);

/** The ledger's matrix table, after proving its ontology is installed (else fail closed). */
async function ledgerTable(ledger: Readonly<AiSpendLedger>, door: string): Promise<string> {
	const table = await getMatrixTableFromTipo(ledger.section);
	const models = await Promise.all([
		getModelByTipo(ledger.user),
		getModelByTipo(ledger.day),
		...KINDS.map((kind) => getModelByTipo(ledger[kind])),
	]);
	// dd663 is stored as component_autocomplete; its RUNTIME model is component_portal.
	const shapeOk =
		models[0] === 'component_portal' &&
		models[1] === 'component_date' &&
		models.slice(2).every((model) => model === 'component_number');
	if (!isMatrixTable(table) || !shapeOk) {
		throw new DedaloError('ai.budget_unavailable', {
			message: `ai_spend: the ledger section '${ledger.section}' is not installed or not the expected shape (master ontology 'dd' missing or damaged)`,
			coordinates: { door, section_tipo: ledger.section },
		});
	}
	return table;
}

/** One limit level's matrix table, after proving its components are numbers (else fail closed). */
async function limitLevelTable(level: Readonly<AiSpendLimitLevel>, door: string): Promise<string> {
	const table = await getMatrixTableFromTipo(level.section);
	const models = await Promise.all(KINDS.map((kind) => getModelByTipo(level[kind])));
	if (!isMatrixTable(table) || !models.every((model) => model === 'component_number')) {
		throw new DedaloError('ai.budget_unavailable', {
			message: `ai_spend: the AI limits of section '${level.section}' are not installed or not the expected shape (master ontology 'dd' missing or damaged)`,
			coordinates: { door, section_tipo: level.section },
		});
	}
	return table;
}

/** The first numeric value of a number component's stored items (a counter: absent = 0). */
function storedCount(bag: Record<string, unknown> | null | undefined, tipo: string): number {
	const items = bag?.[tipo];
	if (!Array.isArray(items)) return 0;
	const value = Number((items[0] as { value?: unknown } | undefined)?.value);
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * A LIMIT as stored: `null` when EMPTY (no key, no item, a null/blank value —
 * inherit from the next level); otherwise a non-negative integer. A value that
 * is set but not a number, or is negative, is 0: an unreadable limit refuses,
 * it never inherits a larger one.
 */
export function storedLimit(
	bag: Record<string, unknown> | null | undefined,
	tipo: string,
): number | null {
	const raw = firstStoredValue(bag?.[tipo]);
	if (isEmptyLimitValue(raw)) return null;
	const value = limitNumber(raw);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** A number, or a numeric string; anything else (a boolean, an array, an object) is NaN — `Number(true)` is 1. */
function limitNumber(raw: unknown): number {
	if (typeof raw === 'number') return raw;
	return typeof raw === 'string' ? Number(raw) : Number.NaN;
}

/** The first item's `value` of a component's stored items (undefined when none). */
function firstStoredValue(items: unknown): unknown {
	if (!Array.isArray(items) || items.length === 0) return undefined;
	return (items[0] as { value?: unknown } | null | undefined)?.value;
}

/** EMPTY = inherit: absent, null, or a blank string. */
function isEmptyLimitValue(raw: unknown): boolean {
	if (raw === undefined || raw === null) return true;
	return typeof raw === 'string' && raw.trim() === '';
}

/** The `number` bag of one record (null when the record does not exist). */
async function readNumberBag(
	table: string,
	sectionTipo: string,
	sectionId: number,
): Promise<Record<string, unknown> | null> {
	const rows = (await sql.unsafe(
		`SELECT number FROM "${table}" WHERE section_tipo = $1 AND section_id = $2 LIMIT 1`,
		[sectionTipo, sectionId],
	)) as { number: Record<string, unknown> | null }[];
	return rows[0]?.number ?? null;
}

/**
 * THE LIMITS RESOLVER: per kind, the user's value when set, else the user's
 * profile's, else 0. Read from the database on every call (no cache). THROWS
 * `ai.budget_unavailable` when the limit components are not installed.
 */
export async function resolveAiSpendLimits(
	principal: Principal,
	options: AiSpendSeam & { door?: string } = {},
): Promise<AiSpendLimits> {
	const tipos = seamLimits(options);
	const door = options.door ?? 'resolveAiSpendLimits';
	const userTable = await limitLevelTable(tipos.user, door);
	const profileTable = await limitLevelTable(tipos.profile, door);
	const userBag = await readNumberBag(userTable, tipos.user.section, principal.userId);
	const profileId = await resolveProfileId(principal.userId);
	const profileBag =
		profileId === null || !Number.isFinite(profileId)
			? null
			: await readNumberBag(profileTable, tipos.profile.section, profileId);
	const limits = {} as AiSpendLimits;
	for (const kind of KINDS) {
		limits[kind] = effectiveLimit(
			storedLimit(userBag, tipos.user[kind]),
			storedLimit(profileBag, tipos.profile[kind]),
		);
	}
	return limits;
}

/** One kind's limit: the user's value when set, else the profile's, else 0. */
function effectiveLimit(own: number | null, inherited: number | null): AiSpendLimits[AiSpendKind] {
	if (own !== null) return { limit: own, source: 'user' };
	if (inherited !== null) return { limit: inherited, source: 'profile' };
	return { limit: 0, source: 'none' };
}

interface LockedDay {
	table: string;
	sectionId: number;
	counters: AiSpendCounters;
}

/** The containment probes that find a (user, day) ledger record. */
function dayProbes(ledger: Readonly<AiSpendLedger>, userId: number, now: Date): [string, string] {
	const { year, month, day } = spendDayDate(now);
	return [
		JSON.stringify({ [ledger.user]: [{ section_tipo: 'dd128', section_id: userId }] }),
		JSON.stringify({ [ledger.day]: [{ start: { year, month, day } }] }),
	];
}

/**
 * Inside the caller's transaction: lock (user, day), find the day's record
 * `FOR UPDATE`, or give birth to it. Returns its live counters.
 */
async function lockDay(
	principal: Principal,
	ledger: Readonly<AiSpendLedger>,
	now: Date,
	door: string,
): Promise<LockedDay> {
	const table = await ledgerTable(ledger, door);
	const day = spendDay(now);
	// The node lock serializes the FIND-OR-CREATE: before the day's birth there
	// is no row for `FOR UPDATE` to lock, and two first spends would both create.
	await acquireNodeLock(ledger.section, `spend_${principal.userId}_${day}`);
	const [userProbe, dayProbe] = dayProbes(ledger, principal.userId, now);
	const rows = (await sql.unsafe(
		`SELECT section_id, number FROM "${table}"
		 WHERE section_tipo = $1 AND relation @> $2::text::jsonb AND date @> $3::text::jsonb
		 ORDER BY section_id LIMIT 1 FOR NO KEY UPDATE`,
		[ledger.section, userProbe, dayProbe],
	)) as { section_id: number; number: Record<string, unknown> | null }[];
	const row = rows[0];
	if (row !== undefined) {
		const counters = {} as AiSpendCounters;
		for (const kind of KINDS) counters[kind] = storedCount(row.number, ledger[kind]);
		return { table, sectionId: Number(row.section_id), counters };
	}
	const sectionId = await createSectionRecord(ledger.section, principal.userId);
	await persistRecordKeys(
		{ table, sectionTipo: ledger.section, sectionId },
		[
			{
				column: 'relation',
				key: ledger.user,
				value: [auditUserLocator(principal.userId, ledger.user)],
			},
			{ column: 'date', key: ledger.day, value: [{ id: 1, start: spendDayDate(now) }] },
		],
		{ userId: principal.userId },
		{ actor: principal.userId },
	);
	return { table, sectionId, counters: { runs: 0, tokens: 0, embeds: 0, vision: 0 } };
}

/** Write the counters that changed (one chokepoint write, stamped as the spender). */
async function writeCounters(
	principal: Principal,
	ledger: Readonly<AiSpendLedger>,
	locked: LockedDay,
	next: AiSpendCounters,
): Promise<void> {
	const savePath: SavePathItem[] = [];
	for (const kind of KINDS) {
		if (next[kind] === locked.counters[kind]) continue;
		savePath.push({ column: 'number', key: ledger[kind], value: [{ id: 1, value: next[kind] }] });
	}
	if (savePath.length === 0) return;
	await persistRecordKeys(
		{ table: locked.table, sectionTipo: ledger.section, sectionId: locked.sectionId },
		savePath,
		{ userId: principal.userId },
		{ actor: principal.userId },
	);
}

/** Apply `delta` to the day's counters (never below 0), under the lock. */
async function adjust(
	principal: Principal,
	ledger: Readonly<AiSpendLedger>,
	now: Date,
	door: string,
	delta: Partial<AiSpendCounters>,
): Promise<void> {
	try {
		await withTransaction(async () => {
			const locked = await lockDay(principal, ledger, now, door);
			const next = { ...locked.counters };
			for (const kind of KINDS) next[kind] = Math.max(0, next[kind] + (delta[kind] ?? 0));
			await writeCounters(principal, ledger, locked, next);
		});
	} catch (error) {
		// A SETTLEMENT never fails the request it settles: the spend already
		// happened, and a ledger that cannot be corrected keeps the RESERVATION
		// charged — the conservative side. Logged, counted, never silent.
		logError(isDedaloError(error) ? error : toDedaloError(error), {
			subsystem: `ai_spend::settle(${door})`,
		});
	}
}

/**
 * RESERVE a spend: THROWS `ai.budget_exhausted` when any requested kind would
 * pass its limit (nothing charged), `ai.budget_unavailable` when the ledger or
 * the limits cannot be used. On success the request is charged and the
 * reservation returned.
 */
export async function reserveAiSpend(
	principal: Principal,
	request: AiSpendRequest,
	options: AiSpendOptions = {},
): Promise<AiSpendReservation> {
	const now = options.now ?? new Date();
	const asked = requested(request);
	let ledger: Readonly<AiSpendLedger> = AI_SPEND_LEDGER;
	try {
		ledger = seamLedger(options);
		await withTransaction(async () => {
			const locked = await lockDay(principal, ledger, now, request.door);
			await options.afterRead?.();
			const limits = await resolveAiSpendLimits(principal, { ...options, door: request.door });
			for (const kind of KINDS) {
				if (asked[kind] === 0) continue;
				const { limit } = limits[kind];
				if (locked.counters[kind] + asked[kind] > limit) {
					throw new DedaloError('ai.budget_exhausted', {
						details: { budget_kind: kind, limit, window_resets_at: budgetResetsAt(now) },
						coordinates: { door: request.door, user_id: principal.userId, day: spendDay(now) },
					});
				}
			}
			const next = { ...locked.counters };
			for (const kind of KINDS) next[kind] += asked[kind];
			await writeCounters(principal, ledger, locked, next);
		});
	} catch (error) {
		unavailable(error, request.door);
	}

	let closed = false;
	return {
		settle: async (usage) => {
			if (closed) return;
			closed = true;
			const reported = usage?.tokens;
			// A missing usage keeps the FULL reservation charged: never settle-to-zero.
			if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0) return;
			const delta = Math.ceil(reported) - asked.tokens;
			if (delta !== 0) await adjust(principal, ledger, now, request.door, { tokens: delta });
		},
		release: async () => {
			if (closed) return;
			closed = true;
			const refund: Partial<AiSpendCounters> = {};
			for (const kind of KINDS) refund[kind] = -asked[kind];
			await adjust(principal, ledger, now, request.door, refund);
		},
	};
}

/** A COUNT-ONLY spend (an embedding query, a vision call): reserved and final in one call. */
export async function chargeAiSpend(
	principal: Principal,
	request: AiSpendRequest,
	options: AiSpendOptions = {},
): Promise<void> {
	await reserveAiSpend(principal, request, options);
}

/** The day's counters for a principal (zeros when nothing was spent). Read-only. */
export async function readAiSpend(
	principal: Principal,
	options: AiSpendSeam & { now?: Date } = {},
): Promise<AiSpendCounters> {
	const ledger = seamLedger(options);
	const table = await ledgerTable(ledger, 'readAiSpend');
	const [userProbe, dayProbe] = dayProbes(ledger, principal.userId, options.now ?? new Date());
	const rows = (await sql.unsafe(
		`SELECT number FROM "${table}"
		 WHERE section_tipo = $1 AND relation @> $2::text::jsonb AND date @> $3::text::jsonb
		 ORDER BY section_id LIMIT 1`,
		[ledger.section, userProbe, dayProbe],
	)) as { number: Record<string, unknown> | null }[];
	const counters = { runs: 0, tokens: 0, embeds: 0, vision: 0 };
	for (const kind of KINDS) counters[kind] = storedCount(rows[0]?.number, ledger[kind]);
	return counters;
}
