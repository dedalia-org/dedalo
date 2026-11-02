/**
 * Per-record authorization scope (PHP assert_record_in_user_scope).
 *
 * The projects filter (component_filter_master / dd170) is a WRITE boundary as
 * well as a read boundary in Dédalo: a user who can edit a section may only
 * touch the records inside their authorized projects. Read paths get this for
 * free (readSection applies the projects filter), but the write handlers (save,
 * delete, duplicate) and the tool record gate must assert it EXPLICITLY on the
 * target section_id — otherwise a level-2 user can mutate a record they can
 * never see (a direct-object-reference / tenant-isolation break).
 *
 * This is the single implementation of that check, reused everywhere so the
 * write scope rule stays byte-identical to list/search enforcement: it runs a
 * PRINCIPAL-SCOPED existence search for the record's locator (buildSearchSql
 * applies the same projects filter as any list) and reports whether the record
 * is visible. Global admins are unscoped and must be short-circuited by the
 * CALLER (they never reach here in the write handlers) — this function makes no
 * admin exception itself so it always answers the literal question "is this
 * record inside the projects filter?".
 *
 * NO SECTION IS SPECIAL-CASED HERE, and none may be. A rule that binds a
 * section (the USERS section's own-record/created_by/shared-projects rule is the
 * one that tempted it) belongs in the ASSEMBLER, where the list, the count, the
 * UNION branches and this existence probe all inherit it at once; a copy here
 * would be an ACL that answers one thing per record and another per list — the
 * exact shape of the oracle bug WC-2026-08-09-users-section-record-scope
 * records. This module therefore contains NO section tipo comparison at all.
 * Gated behaviourally by test/unit/oh1_permissions_native.test.ts "the
 * per-record answer EQUALS the list answer, record by record".
 */

import { CLIENT_MAX_LIMIT, CLIENT_MAX_LOCATOR_PINS, sanitizeClientSqo } from '../concepts/sqo.ts';
import { sql } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { runSearch } from '../search/search_statement.ts';
import { buildRowsInScopeSql, buildSearchSql } from '../search/sql_assembler.ts';
import { getPermissions, type Principal } from './permissions.ts';

/**
 * True when a principal-scoped existence search for `sectionTipo/sectionId`
 * returns the record — i.e. it is inside the caller's projects filter. Callers
 * that grant global admins unconditional access must check `isGlobalAdmin`
 * themselves before calling this.
 *
 * ONE RULE, TWO DOORS. Every section — the USERS section (dd128) included —
 * answers through the SAME predicate the list/search path applies, because this
 * function runs the real assembler (search/sql_assembler.ts buildSearchSql) with
 * the principal attached. The dd128 rule therefore lives in exactly one place,
 * buildUsersProjectsFilter, and a per-record answer can never drift from what
 * the list shows.
 *
 * DIVERGENCE FROM THE ORACLE, declared as
 * WC-2026-08-09-users-section-record-scope: PHP's per-record helper
 * security::user_can_access_record (class.security.php:1035-1058) short-circuits
 * only the caller's OWN dd128 row and then falls through to the component_filter
 * lookup, which dd128 has none of, so PHP `return true`s for EVERY user record —
 * an IDOR against its own list filter, which hides those same records. TS makes
 * the two doors agree on the restrictive side. PHP's own-record allowance is
 * kept, moved into the assembler predicate so the list honours it too (a
 * projects-less user must be able to read their own account).
 */
export async function isRecordInScope(
	sectionTipo: string,
	sectionId: number,
	principal: Principal,
): Promise<boolean> {
	const visible = await visibleSectionIds(sectionTipo, [sectionId], principal);
	return visible.has(Number(sectionId));
}

/**
 * How many record addresses one scope probe pins at a time.
 *
 * The probe is an ORDINARY CLIENT SQO run through `sanitizeClientSqo`, and that
 * sanitizer CLAMPS both halves this depends on: `filter_by_locators` at
 * {@link CLIENT_MAX_LOCATOR_PINS} and `limit` at {@link CLIENT_MAX_LIMIT}
 * (config-driven). A chunk above either ceiling would be silently truncated —
 * and a truncated probe does not fail loudly, it HIDES records the caller may
 * legitimately see. The chunk is therefore derived from both ceilings rather
 * than declared, so an installation that lowers `searchClientMaxLimit` cannot
 * turn this into a silent under-answer.
 */
const SCOPE_PROBE_CHUNK = Math.max(1, Math.min(200, CLIENT_MAX_LIMIT, CLIENT_MAX_LOCATOR_PINS));

/**
 * THE PREDICATE, STATED ONCE — which of `sectionIds` this principal may see in
 * `sectionTipo`, asked of the real assembler in ONE statement per chunk.
 *
 * Both doors of this module run through here: {@link isRecordInScope} asks it
 * for a single id, {@link scopeInverseReferenceHits} asks it for a whole hit
 * list. That is deliberate and is the module's own law (see the docblock on
 * scopeInverseReferenceHits: "the boundary must never be re-decided per
 * caller") — a batched COPY of the rule would be a second ACL, free to drift
 * from the one the list path applies.
 *
 * WHY BATCHED (PERF-01 / P2-11). The per-hit form ran `sanitizeClientSqo` +
 * `buildSearchSql` + one `sql.unsafe` PER CANDIDATE: an identification pool of
 * 500 records cost 500 assembler runs and 500 round-trips, all of them the same
 * query with one number changed. `filter_by_locators` is the assembler's own
 * OR-of-locators shape, so the same predicate answers the whole chunk at once —
 * same WHERE clauses, same projects filter, same exemptions, one statement.
 *
 * `idsOnly` because a boolean needs no data columns: the ten wide jsonb columns
 * the default projection carries were never read by either caller.
 */
async function visibleSectionIds(
	sectionTipo: string,
	sectionIds: readonly number[],
	principal: Principal,
): Promise<Set<number>> {
	const visible = new Set<number>();
	for (let start = 0; start < sectionIds.length; start += SCOPE_PROBE_CHUNK) {
		const chunk = sectionIds.slice(start, start + SCOPE_PROBE_CHUNK);
		const scopeSqo = sanitizeClientSqo({
			section_tipo: [sectionTipo],
			filter_by_locators: chunk.map((sectionId) => ({
				section_tipo: sectionTipo,
				section_id: sectionId,
			})),
			// Exactly the chunk: every pinned record may legitimately be visible,
			// and a smaller limit would drop survivors as if they were denied.
			limit: chunk.length,
		});
		// `unknown`, not `number | string`: the driver's row type is not a
		// place to widen the section_id union (WC-2026-08-10-section-id-int-canonical
		// — section_id_int_tripwire ratchets this file at zero), and every use
		// below canonicalizes through Number() anyway.
		const rows = await runSearch<{ section_id: unknown }>(
			await buildSearchSql(scopeSqo, { principal, idsOnly: true }),
		);
		for (const row of rows) visible.add(Number(row.section_id));
	}
	return visible;
}

/**
 * Admin-aware convenience wrapper over {@link isRecordInScope}: global admins are
 * unconditionally allowed (unscoped); everyone else must have the record inside
 * their projects filter. This is the SHARED per-record read/write scope gate —
 * every caller that addresses a record by (section_tipo, section_id) outside the
 * list/search path (get_data reads, resolve_data targets, MCP write tools) must
 * funnel through here so the tenant boundary cannot be forgotten at a new door
 * (foundation security audit AUTHZ-01/AUTHZ-02/AI-01: the filter was enforced
 * per-caller, not per-engine, so three doors skipped it).
 */
export async function principalCanAccessRecord(
	sectionTipo: string,
	sectionId: number,
	principal: Principal,
): Promise<boolean> {
	// PHP security::user_can_access_record (class.security.php:1007-1009): a
	// non-positive section_id is never accessible as a record, checked BEFORE
	// the global-admin bypass and for ALL sections (blocks record-level reach
	// to the root user dd128/-1 through get_data, MCP writes, change-plan).
	if (sectionId < 1) return false;
	if (principal.isGlobalAdmin) return true;
	return isRecordInScope(sectionTipo, sectionId, principal);
}

/**
 * THE WRITE-DOOR TARGET GATE (P1-2, closes SEC-05) — the throwing form of
 * {@link principalCanAccessRecord}, in the order that matters.
 *
 * The three record-lifecycle doors (save, duplicate, delete) each wrote the scope check
 * as `if (!principal.isGlobalAdmin) { isRecordInScope(...) }`. That inlines the admin
 * bypass ABOVE the non-positive-id refusal, so for an admin-flagged principal the
 * refusal never executed at all — and `root_user_hidden_tripwire` asserted the property
 * of the FUNCTION while every DOOR skipped it. Root (dd128/-1) is a strictly higher tier
 * than global admin everywhere else in the codebase, and its password was rewritable by
 * any global admin holding a level-2 grant on `(dd128, dd133)`.
 *
 * Calling this instead makes the order un-inlineable: the non-positive-id refusal is
 * inside the same function as the bypass, ahead of it, exactly as
 * `principalCanAccessRecord` has always had it.
 *
 * ONE LEGITIMATE FLOW WRITES A NON-POSITIVE RECORD ID, AND EXACTLY ONE — MEASURED, not
 * assumed. Every `matrix*` table carrying a `section_id` was counted read-only on
 * 2026-08-28 across the suite database and the live installation `dedalo_v7_mht`: the
 * ONLY row with `section_id < 1` anywhere is `matrix_users` dd128/-1, root itself. And
 * by construction: root is seeded by the install SQL
 * (`install/db/dedalo_install.pgsql.gz`, one COPY row), not through the API;
 * `createSectionRecord` allocates from the section counter and can only return a
 * positive id; both delete engines already refuse `sectionId < 1` themselves
 * (`delete_record.ts:73` and `:544`); the fixtures and the test corpus insert through
 * `insertMatrixRecordWithCounter`, positive by construction.
 *
 * That one flow is ROOT EDITING ITS OWN ACCOUNT — `selfServiceAccountWrite`, below. The
 * first shape of this gate had no exception, and the side effect nobody chose was that
 * root could no longer change its own password or its own email through the engine
 * either, while `password_reset.ts` excludes root from the emailed recovery flow by the
 * same `id > 0` rule: an installation with no in-engine way to rotate its most
 * privileged credential.
 */
export async function assertRecordWriteTarget(
	sectionTipo: string,
	sectionId: number,
	principal: Principal,
	operation: string,
	options: {
		/**
		 * The ONE exception to the non-positive-id refusal: the actor is editing one of
		 * its OWN account's self-editable components on its OWN record.
		 *
		 * A BOOLEAN, computed by the caller through `permissions.isSelfServiceAccountWrite`
		 * — deliberately not a section tipo or a component tipo passed in here. This
		 * module contains no section comparison at all, and none may be added: a rule
		 * that binds a section belongs in the ASSEMBLER, where the list, the count, the
		 * UNION branches and the existence probe all inherit it at once (see the module
		 * docblock and WC-2026-08-09-users-section-record-scope). The predicate lives
		 * beside `SELF_EDITABLE_COMPONENTS`, which is the only place that set is stated.
		 *
		 * It is re-checked against `principal.userId` here anyway, so a caller that
		 * passes `true` for someone else's record still gets the ordinary refusal.
		 */
		selfServiceAccountWrite?: boolean;
	} = {},
): Promise<void> {
	if (options.selfServiceAccountWrite === true && sectionId === principal.userId) return;
	if (await principalCanAccessRecord(sectionTipo, sectionId, principal)) return;
	throw new DedaloError('perm.out_of_scope', {
		message:
			sectionId < 1
				? `${operation}: ${sectionTipo}/${String(sectionId)} is not a writable record address — a non-positive section_id is refused for EVERY caller, global admins included (only the account itself may edit its own name/email/password/image).`
				: `${operation}: ${sectionTipo}/${String(sectionId)} is outside the caller's scope`,
		coordinates: { section_tipo: sectionTipo, section_id: sectionId, operation },
	});
}

/**
 * LEG 1 of {@link scopeInverseReferenceHits}, extracted so each leg stays one
 * readable decision: the hits whose SECTION the principal may read, in input
 * order, together with the per-section id sets the projects probe then asks
 * about (deduplicated for the query, re-expanded onto the input by the caller).
 * One `getPermissions` per distinct section, cached across the walk.
 */
async function hitsWithSectionGrant<T extends { section_tipo: string; section_id: number }>(
	hits: readonly T[],
	principal: Principal,
): Promise<{ granted: T[]; probeIds: Map<string, Set<number>> }> {
	const sectionReadable = new Map<string, boolean>();
	const granted: T[] = [];
	const probeIds = new Map<string, Set<number>>();
	for (const hit of hits) {
		let readable = sectionReadable.get(hit.section_tipo);
		if (readable === undefined) {
			readable = (await getPermissions(principal, hit.section_tipo, hit.section_tipo)) >= 1;
			sectionReadable.set(hit.section_tipo, readable);
		}
		if (!readable) continue;
		granted.push(hit);
		const ids = probeIds.get(hit.section_tipo);
		if (ids === undefined) probeIds.set(hit.section_tipo, new Set([Number(hit.section_id)]));
		else ids.add(Number(hit.section_id));
	}
	return { granted, probeIds };
}

/**
 * Drop record hits a principal cannot reach (AUTHZ-05) — the LIST-shaped twin of
 * {@link principalCanAccessRecord}. A hit survives only when the caller (a)
 * holds a read grant on its SECTION and (b) has the RECORD inside their projects
 * filter. Global admins are unscoped (the current, correct behavior). One
 * getPermissions per distinct section (cached); ONE STATEMENT per (section,
 * chunk of {@link SCOPE_PROBE_CHUNK} records) — never one per hit.
 *
 * NAMED for the door it was written at: the inverse scan
 * (search_related.findInverseReferences) is a shared low-level primitive that
 * runs over 'all' owning sections with NO principal — many system paths
 * (diffusion resolve, observers, children) depend on it staying unscoped — so
 * the USER-FACING doors (the relation-list panel + its paginator count) scope
 * its output here before emitting existence / labels / counts. Before this, a
 * non-admin holding only the HOST record's read grant enumerated referencing
 * records in sections + projects they had zero access to.
 *
 * The RULE is general, so the function is too: any deliberately unscoped scan
 * (an inverse-reference walk, a vector hit list, an identification candidate
 * pool) gates through this one implementation at its user-facing door — import
 * it as {@link scopeRecordHits} when the caller is not inverse references. The
 * boundary must never be re-decided per caller.
 *
 * Deliberately silent about what it dropped: a "n hidden" count is an existence
 * oracle for records the caller may not see.
 */
export async function scopeInverseReferenceHits<
	T extends { section_tipo: string; section_id: number },
>(hits: T[], principal: Principal): Promise<T[]> {
	if (principal.isGlobalAdmin) return hits;

	// LEG 1 — the section read grant, per distinct section, in input order.
	const { granted, probeIds } = await hitsWithSectionGrant(hits, principal);

	// LEG 2 — the projects boundary, ONE probe per (section, chunk). The ids are
	// deduplicated for the query and re-expanded onto the input below, so a hit
	// repeated in the input is not silently collapsed, and the survivors come
	// back in INPUT ORDER: callers rank by score/similarity, and a reordered
	// answer would be a wire change nobody asked for.
	const visible = new Map<string, Set<number>>();
	for (const [sectionTipo, ids] of probeIds) {
		visible.set(sectionTipo, await visibleSectionIds(sectionTipo, [...ids], principal));
	}
	return granted.filter(
		(hit) => visible.get(hit.section_tipo)?.has(Number(hit.section_id)) === true,
	);
}

/** A caller's SELECT yielding `(section_tipo, section_id)` rows, bound to its own `$1..$N`. */
export interface BoundRows {
	readonly sql: string;
	readonly params: readonly unknown[];
}

/**
 * THE SET-SHAPED TWIN of {@link scopeInverseReferenceHits}: the rows of `rows`
 * that survive this principal's scope, as a bound SELECT of the same columns —
 * the same two legs, asked of the database instead of a hit list the caller
 * fetched, for a question whose candidate set has no bound (the related
 * search's count, page and past-the-page probe — D1 2026-10-21 — and READ-4's
 * indexation-grid probe).
 *
 * - global admin: unscoped, as in the hit-list door — `rows` unchanged;
 * - LEG 1, the section read grant: the DISTINCT sections the rows land in (one
 *   row per section, never per record), judged by the same grant check
 *   ({@link hitsWithSectionGrant});
 * - LEG 2, the per-record scope: each granted section's records joined under
 *   the assembler's own predicate (search/sql_assembler.ts buildRowsInScopeSql).
 *
 * Bounded whatever the candidate count: one statement here (the section list,
 * at most one row per SECTION) plus what the predicate builders read through
 * their caches; the caller's own statement then counts / windows / EXISTS-tests
 * the scoped set. No granted section ⇒ the empty set. A row naming no section
 * (NULL) names no record: it reaches the grant leg as no readable section and
 * is dropped there.
 */
export async function scopedRows(rows: BoundRows, principal: Principal): Promise<BoundRows> {
	if (principal.isGlobalAdmin) return rows;
	const sections = (await sql.unsafe(
		`SELECT DISTINCT scoped_rows.section_tipo FROM (${rows.sql}) AS scoped_rows`,
		rows.params as (string | number | null)[],
	)) as { section_tipo: string | null }[];
	const { granted } = await hitsWithSectionGrant(
		sections.map((row) => ({ section_tipo: String(row.section_tipo), section_id: 0 })),
		principal,
	);
	return buildRowsInScopeSql(
		rows,
		granted.map((hit) => hit.section_tipo),
		principal,
	);
}

/**
 * {@link scopedRows} bound to one principal — the `scope` a principal-free
 * sink (search/search_related.ts) takes, so the sink stays free of the
 * security layer and every asker of one related question (count, page, probe)
 * scopes it through THIS one predicate. A user-facing door passes it; a system
 * walk passes none (AUTHZ-05 door registry,
 * security_audit_2026_07_23_tripwire).
 */
export function rowScopeFor(principal: Principal): (rows: BoundRows) => Promise<BoundRows> {
	return (rows) => scopedRows(rows, principal);
}

/**
 * Does ANY row of `rows` survive this principal's scope? One EXISTS over
 * {@link scopedRows} — stopping at the first visible record. Discloses a
 * boolean about records the caller may see, nothing about the others.
 */
export async function anyRowInScope(rows: BoundRows, principal: Principal): Promise<boolean> {
	const scoped = await scopedRows(rows, principal);
	const found = (await sql.unsafe(
		`SELECT EXISTS (SELECT 1 FROM (${scoped.sql}) AS any_rows) AS found`,
		scoped.params as (string | number | null)[],
	)) as { found: boolean }[];
	return found[0]?.found === true;
}

/**
 * The name callers that are NOT inverse references import
 * {@link scopeInverseReferenceHits} by (the identification candidate pool is the
 * first). An ALIAS, never a copy: one implementation of the rule, two readable
 * doors — and the AUTHZ-05 tripwire keeps pinning the original export.
 */
export const scopeRecordHits = scopeInverseReferenceHits;

/**
 * AUTHZ-02 — drop CLIENT-SUPPLIED target locators the principal may not resolve.
 *
 * A non-admin must not read the child values of a record outside their projects
 * filter by injecting its locator and letting the standard expansion resolve it.
 * Two doors hand the engine locators that never came from a stored record — the
 * search-chip `resolve_data` path and the WC-079 temporal scratch graft — and
 * both must scope them.
 *
 * Extracted so the two cannot drift: the scratch store shipped without this
 * filter and was a live cross-tenant read (a level-1 grant plus an injected
 * locator returned another tenant's field values).
 *
 * Locators with no (section_tipo, section_id) identity carry nothing to scope
 * and pass through. Global admins are unscoped.
 *
 * (!) Applied at READ time, not only at write time: a principal's projects
 * assignment can change after a locator was stored, so a write-time filter alone
 * would let a stale row outlive the grant that justified it.
 */
export async function filterLocatorsInScope<T extends Record<string, unknown>>(
	locators: readonly T[],
	principal: Principal | undefined,
	usersSectionTipo: string,
): Promise<T[]> {
	if (principal === undefined || principal.isGlobalAdmin || locators.length === 0) {
		return [...locators];
	}
	const scoped: T[] = [];
	for (const locator of locators) {
		const locSectionTipo = locator.section_tipo;
		const locSectionId = locator.section_id;
		if (typeof locSectionTipo !== 'string' || locSectionId === undefined || locSectionId === null) {
			scoped.push(locator);
			continue;
		}
		// The root user locator (dd128/-1) resolves to a LABEL only, and PHP
		// resolves it for any caller with section-level permission — activity "who"
		// chips must render. Record access stays blocked by the assembler's
		// section_id > 0 filter and principalCanAccessRecord.
		if (locSectionTipo === usersSectionTipo && Number(locSectionId) === -1) {
			scoped.push(locator);
			continue;
		}
		if (await isRecordInScope(locSectionTipo, Number(locSectionId), principal)) {
			scoped.push(locator);
		}
	}
	return scoped;
}
