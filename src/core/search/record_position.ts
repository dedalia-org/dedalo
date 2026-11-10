/**
 * RECORD POSITION — where one record sits inside a found set.
 *
 * The edit view of a section is a PAGE VIEW: `limit 1` over the user's found
 * set (filter + order), the record named by its `offset`. A reload of
 * `?tipo=X&mode=edit&id=N` carries only the id; without its position the
 * client could only pin the record alone (paginator 1/1, no prev/next). This
 * module answers "at which offset of THIS found set does (tipo, id) sit?" so
 * the deep link reopens INSIDE the navigation it came from
 * (WC-2026-11-09-start-deep-link-found-set-position).
 *
 * Read-only, principal-scoped (the same buildSearchSql the edit read runs:
 * projects ACL, dd478 allow-list, per-component frontier), and it runs ONLY
 * through the one search executor (runSearch / wrapSearch), so a
 * `referenced_by` leaf stays bounded.
 *
 * BOUNDED, because it runs inside `start` — the page boot. Every answer it
 * cannot give cheaply degrades to "no position" (the caller pins the record
 * alone, the pre-2026-11-09 behaviour), never to a slow or failed page:
 *  - a record that is not a real, readable record (non-integer id, id < 1,
 *    deleted, out of scope) is refused by a one-row pin probe BEFORE any scan;
 *  - the numbering scan runs under DEEP_LINK_POSITION_BUDGET_MS.
 */

import { compareLocators } from '../concepts/locator.ts';
import { isFoundSetSqoOf, type Sqo } from '../concepts/sqo.ts';
import { withStatementBudget } from '../db/postgres.ts';
import { isDedaloError } from '../errors/dedalo_error.ts';
import type { Principal } from '../security/permissions.ts';
import { runSearch, wrapSearch } from './search_statement.ts';
import { buildSearchSql } from './sql_assembler.ts';

/**
 * The statement budget of ONE numbering scan. A reload must not wait on a
 * full ordered walk of a multi-million-row section (Activity's newest-first
 * order, a jsonb component sort over a large section, a record far from the
 * top): past this, the deep link opens pinned alone — the same view the
 * engine served before positions existed, so nothing is lost but the
 * paginator. Generous for the common case (an indexed `section_id` walk of a
 * few hundred thousand rows is well under it).
 */
export const DEEP_LINK_POSITION_BUDGET_MS = 3000;

type SectionRow = { section_tipo: string; section_id: number };

/** Run `sqo` (ids only) and return its rows. */
async function searchIds(sqo: Sqo, principal: Principal): Promise<SectionRow[]> {
	return runSearch<SectionRow>(await buildSearchSql(sqo, { principal, idsOnly: true }));
}

/**
 * Is (sectionTipo, sectionId) a record `principal` can read? One pin probe
 * through the same search the edit read runs — so a deleted id, an id outside
 * the projects scope, or an id the dd478 allow-list hides answers false
 * (start's deepLinkRecordInScope exempts global admins and non-numeric ids;
 * this probe does not).
 */
async function recordIsReadable(
	sectionTipo: string,
	sectionId: number,
	principal: Principal,
): Promise<boolean> {
	const pin = {
		section_tipo: [sectionTipo],
		filter_by_locators: [{ section_tipo: sectionTipo, section_id: sectionId }],
		limit: 1,
		offset: 0,
		parsed: false,
	} as unknown as Sqo;
	return (await searchIds(pin, principal)).length > 0;
}

/** Does the record at `offset` of the found set carry `sectionId`? (one-row probe) */
async function recordAtOffsetIs(
	sqo: Sqo,
	offset: number,
	sectionTipo: string,
	sectionId: number,
	principal: Principal,
): Promise<boolean> {
	const probe = { ...sqo, limit: 1, offset, full_count: false, parsed: false } as Sqo;
	const [row] = await searchIds(probe, principal);
	const target = { section_tipo: sectionTipo, section_id: sectionId };
	return row !== undefined && compareLocators(row, target, ['section_tipo', 'section_id']);
}

/** The stored offset as a usable row index, or null. */
function storedOffsetOf(sqo: Sqo): number | null {
	return typeof sqo.offset === 'number' && sqo.offset >= 0 ? Math.trunc(sqo.offset) : null;
}

/** A real record id: an integer >= 1 (the canonical int of a URL id). */
function isRecordId(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 1;
}

/**
 * 0-based position of (sectionTipo, sectionId) in the found set of `sqo`, for
 * `principal`; null when the record is not in it OR the numbering scan ran
 * past its budget (reported).
 *
 * Cheap path first: the stored offset usually still names the record (the
 * reload of the page the user was on), a one-row probe. Otherwise ONE
 * statement numbers the ordered found set and picks the record's row.
 *
 * Order fidelity: the inner search is the SAME buildSearchSql the edit read
 * pages (its ORDER BY — the requested sort with its `NULLS LAST, section_id`
 * tie-breaker, else the implicit `section_id ASC` — is a total order), and
 * `row_number() OVER ()` numbers the subquery's rows in the order the ordered
 * subquery scan delivers them (an ORDER BY subquery is not pulled up, an
 * empty window adds no sort). Gated against the read's own pagination for a
 * DESC order and for a component sort (start_deep_link_navigation_native).
 */
export async function findRecordPosition(
	sqo: Sqo,
	sectionTipo: string,
	sectionId: number,
	principal: Principal,
): Promise<number | null> {
	const storedOffset = storedOffsetOf(sqo);
	if (
		storedOffset !== null &&
		(await recordAtOffsetIs(sqo, storedOffset, sectionTipo, sectionId, principal))
	) {
		return storedOffset;
	}
	return numberedPosition(sqo, sectionTipo, sectionId, principal);
}

/**
 * ONE statement: number the ordered found set and pick the record's row,
 * under DEEP_LINK_POSITION_BUDGET_MS. Past the budget: null (reported).
 */
async function numberedPosition(
	sqo: Sqo,
	sectionTipo: string,
	sectionId: number,
	principal: Principal,
): Promise<number | null> {
	const wholeFoundSet = { ...sqo, limit: null, offset: 0, full_count: false, parsed: false } as Sqo;
	const base = await buildSearchSql(wholeFoundSet, { principal, idsOnly: true });
	const numbered = wrapSearch(
		base,
		(inner, next) =>
			`SELECT numbered.position FROM (
				SELECT found.section_tipo, found.section_id, (row_number() OVER ()) - 1 AS position
				FROM (${inner}) AS found
			) AS numbered
			WHERE numbered.section_tipo = $${next} AND numbered.section_id = $${next + 1}
			LIMIT 1`,
		[sectionTipo, sectionId],
	);
	try {
		const [row] = await withStatementBudget(DEEP_LINK_POSITION_BUDGET_MS, () =>
			runSearch<{ position: number | string }>(numbered),
		);
		return row === undefined ? null : Number(row.position);
	} catch (error) {
		// Swallowed (CONVENTIONS.md): best-effort by design — the position only
		// seeds the paginator; REPORTED; degraded behaviour defined — no position,
		// the record opens pinned alone. Any other failure propagates.
		if (!isDedaloError(error) || error.code !== 'db.statement_timeout') throw error;
		console.warn(
			`[record_position] position scan of ${sectionTipo}/${sectionId} ran past ${DEEP_LINK_POSITION_BUDGET_MS}ms — the deep link opens the record alone`,
			error,
		);
		return null;
	}
}

/**
 * THE DEEP-LINK NAVIGATION of a section edit view: the page-view SQO that
 * opens `sectionId` at its position, or null (the caller keeps the pin).
 *
 *  0. only a real, readable record (integer id >= 1, the pin probe) — any other
 *     id has no position and costs no scan;
 *  1. the user's stored found set (session SQO) when it holds the record —
 *     the reload of the page they were on, filter and order intact;
 *  2. else the whole section in its default order (a pasted link, a fresh
 *     session, a record the current filter excludes) — prev/next over every
 *     record the user may read.
 *
 * The returned SQO states `filter`, `order`, `filter_by_locators` and
 * `children_recursive` EXPLICITLY: the session merge fills only ABSENT keys
 * (concepts/sqo.ts mergeSessionSqo), so an omitted key would let the stored
 * filter — or a stored descendant expansion — leak back into the navigation
 * the position was computed for.
 */
export async function resolveDeepLinkNavigation(
	sectionTipo: string,
	sectionId: unknown,
	principal: Principal,
	storedSqo: unknown,
): Promise<Sqo | null> {
	if (!isRecordId(sectionId)) return null;
	if (!(await recordIsReadable(sectionTipo, sectionId, principal))) return null;
	const stored = await storedNavigation(storedSqo, sectionTipo, sectionId, principal);
	return stored ?? (await wholeSectionNavigation(sectionTipo, sectionId, principal));
}

/** Step 1: the navigation inside the stored found set, or null. */
async function storedNavigation(
	storedSqo: unknown,
	sectionTipo: string,
	sectionId: number,
	principal: Principal,
): Promise<Sqo | null> {
	if (!isFoundSetSqoOf(storedSqo, sectionTipo)) return null;
	const stored = structuredClone(storedSqo);
	const position = await storedFoundSetPosition(stored, sectionTipo, sectionId, principal);
	return position === null ? null : navigationAt(stored, position);
}

/**
 * Step 2: the navigation over the whole section, or null. Not swallowed
 * (beyond the scan budget): it is the same search as the section's own
 * unfiltered list, so a failure here is the section's, not navigation state's.
 */
async function wholeSectionNavigation(
	sectionTipo: string,
	sectionId: number,
	principal: Principal,
): Promise<Sqo | null> {
	const wholeSection = {
		section_tipo: [sectionTipo],
		filter: null,
		order: null,
		filter_by_locators: [],
		children_recursive: false,
		offset: null,
	} as unknown as Sqo;
	const position = await findRecordPosition(wholeSection, sectionTipo, sectionId, principal);
	return position === null ? null : navigationAt(wholeSection, position);
}

/**
 * The record's position in the STORED found set — or null when it is not
 * there OR the stored SQO no longer builds.
 *
 * The stored SQO is navigation state, not a request: it lives in the session
 * row across restarts and ontology updates, so a filter leaf can name a tipo
 * that has since been removed or re-modelled (conform throws
 * request.invalid_tipo / request.invalid_model / engine.uncovered_scope). Thrown
 * here, it would fail the PAGE BOOT (`start`) of every edit URL of the section
 * until logout. Swallowed (CONVENTIONS.md, all three conditions): best-effort by
 * design (the stored SQO only seeds the navigation), REPORTED with its
 * coordinates, and the degraded behaviour is defined — the deep link opens
 * over the whole section instead, and the edit read that follows replaces the
 * unbuildable stored SQO.
 */
async function storedFoundSetPosition(
	stored: Sqo,
	sectionTipo: string,
	sectionId: number,
	principal: Principal,
): Promise<number | null> {
	try {
		return await findRecordPosition(stored, sectionTipo, sectionId, principal);
	} catch (error) {
		console.warn(
			`[record_position] stored session SQO of ${sectionTipo} does not build — deep link to ${sectionId} falls back to the whole section`,
			error,
		);
		return null;
	}
}

/** The page-view SQO at `position`, its navigation keys stated explicitly. */
function navigationAt(candidate: Sqo, position: number): Sqo {
	return {
		...candidate,
		filter: candidate.filter ?? null,
		order: candidate.order ?? null,
		filter_by_locators: candidate.filter_by_locators ?? [],
		children_recursive: false,
		limit: 1,
		offset: position,
		full_count: false,
		parsed: false,
	} as Sqo;
}
