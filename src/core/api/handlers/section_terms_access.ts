/**
 * SECTION-TERMS READ DOOR — which locators of a `get_section_terms` batch the
 * caller may have the section_map display term of
 * (WC-2026-11-10-section-terms-read-door; owner decision S12 2026-11-10).
 *
 * The door quotes a COMPONENT VALUE (the term component of each named record),
 * so it is gated like every other door that quotes one (security/read_door.ts):
 *
 *   1. the COMPONENT KEY, per section (asked once per distinct section of the
 *      batch): the section read grant AND the grant on EVERY term component the
 *      section_map draws the term from (`getTermTipos`) — `doorComponentAllowed`,
 *      the human read's own pair. ALL, not any: the term is the JOIN of every
 *      fragment, each fragment is the value of its own component, and "as
 *      displayed" means each one must be readable through the component it is
 *      drawn from. A term partially drawn from a refused component is omitted
 *      whole — never re-joined from the granted fragments only (that would be a
 *      label the record never displays, and it would share the term cache key
 *      with the full one).
 *   2. the RECORD KEY: the address the term read actually hits must be inside
 *      the caller's scope — the projects predicate the list applies, asked in
 *      ONE statement per section chunk (`scopeInverseReferenceHits`, the
 *      batched twin of `principalCanAccessRecord`; global admins unscoped).
 *
 * WHICH ADDRESS. The term resolver reads the matrix row at `Number(section_id)`
 * (ts_object/term_resolver.ts readComponentItems), and the batch keeps the id in
 * its INCOMING form (handlers/section_terms.ts — external remote ids and graph
 * tokens legitimately flow). So the scoped address is derived by the SAME
 * `Number()`, never by a stricter parser: '001338683' reads record 1338683 and is
 * scoped as 1338683 (a stricter parser would let it read unscoped). A form whose
 * `Number()` is not an integer ('abc', '1.5', a synthetic token) addresses no
 * row — the resolver reads nothing and the term is '' — so it carries nothing to
 * scope and passes through unchanged. A non-positive integer is never a record
 * a caller may reach (`principalCanAccessRecord`: checked before any admin
 * bypass) and is omitted for everyone.
 *
 * REFUSAL LAW (batch semantics): a refused locator is OMITTED from the term map —
 * the map is keyed by the caller's own locators, so an absent key IS the answer
 * and the client keeps its provisional label. Never silent: every refusal is
 * recorded through `noteFrontierRefusal` (log line + the request's ONE
 * `perm.out_of_scope` notice, readDoorNotices) — once per refused (section,
 * component) pair and once per section with out-of-scope records, so a 1000-
 * locator batch cannot flood the operator log.
 */

import { noteFrontierRefusal } from '../../security/frontier_scope.ts';
import type { Principal } from '../../security/permissions.ts';
import { doorComponentAllowed, type ReadDoorScope } from '../../security/read_door.ts';
import { getTermTipos } from '../../ts_object/term_resolver.ts';
import type { NormalizedTermLocator } from './section_terms.ts';

/** The door name the refusal log line and the posture map use. */
export const SECTION_TERMS_DOOR = 'dd_core_api.get_section_terms';

/**
 * The matrix address the term resolver reads for a batch section_id, or null
 * when it addresses no row (see the module header — the SAME `Number()`).
 */
export function termRecordAddress(sectionId: string | number): number | null {
	const address = Number(sectionId);
	return Number.isSafeInteger(address) ? address : null;
}

/**
 * Per section: does the section map a term at all, and may the caller read
 * every component it is drawn from? `false` for an untermed section is NOT a
 * refusal (nothing to quote — the pre-existing skip that protects the client's
 * provisional label); a refused pair is recorded by doorComponentAllowed.
 */
async function sectionTermReadable(
	readScope: ReadDoorScope,
	sectionTipo: string,
	scope: string | null,
): Promise<boolean> {
	const termTipos = await getTermTipos(sectionTipo, scope);
	if (termTipos.length === 0) return false;
	for (const componentTipo of termTipos) {
		if (!(await doorComponentAllowed(readScope, { sectionTipo, componentTipo }))) return false;
	}
	return true;
}

/** Step 1 — the component key, asked once per distinct section of the batch. */
async function entriesWithReadableTerm(
	readScope: ReadDoorScope,
	entries: readonly NormalizedTermLocator[],
	scope: string | null,
): Promise<NormalizedTermLocator[]> {
	const sectionReadable = new Map<string, Promise<boolean>>();
	const keyed: NormalizedTermLocator[] = [];
	for (const entry of entries) {
		let readable = sectionReadable.get(entry.section_tipo);
		if (readable === undefined) {
			readable = sectionTermReadable(readScope, entry.section_tipo, scope);
			sectionReadable.set(entry.section_tipo, readable);
		}
		if (await readable) keyed.push(entry);
	}
	return keyed;
}

/** One batch entry as the record key sees it. */
type ScopeProbe = { section_tipo: string; section_id: number; key: string };

/**
 * Step 2 split: entries addressing no row pass (nothing to scope), non-positive
 * addresses are refused, the rest go to the batched scope probe.
 */
function classifyAddresses(entries: readonly NormalizedTermLocator[]): {
	passthrough: string[];
	refusedSections: string[];
	probes: ScopeProbe[];
} {
	const passthrough: string[] = [];
	const refusedSections: string[] = [];
	const probes: ScopeProbe[] = [];
	for (const entry of entries) {
		const address = termRecordAddress(entry.section_id);
		if (address === null) passthrough.push(entry.key);
		else if (address < 1) refusedSections.push(entry.section_tipo);
		else probes.push({ section_tipo: entry.section_tipo, section_id: address, key: entry.key });
	}
	return { passthrough, refusedSections, probes };
}

/** Step 2 — the record key, batched: one scope statement per (section, chunk). */
async function visibleProbeKeys(
	probes: readonly ScopeProbe[],
	principal: Principal,
): Promise<Set<string>> {
	if (probes.length === 0) return new Set();
	const { scopeInverseReferenceHits } = await import('../../security/record_scope.ts');
	const visible = await scopeInverseReferenceHits([...probes], principal);
	return new Set(visible.map((hit) => hit.key));
}

/**
 * The entries of a normalized batch whose term the principal may read, in
 * INPUT ORDER (the response map's key order is the batch order, as before).
 */
export async function admitTermLocators(
	principal: Principal,
	entries: readonly NormalizedTermLocator[],
	scope: string | null,
): Promise<NormalizedTermLocator[]> {
	const readScope: ReadDoorScope = { principal, door: SECTION_TERMS_DOOR };
	const keyed = await entriesWithReadableTerm(readScope, entries, scope);
	const { passthrough, refusedSections, probes } = classifyAddresses(keyed);
	const visibleKeys = await visibleProbeKeys(probes, principal);

	const admittedKeys = new Set<string>([...passthrough, ...visibleKeys]);
	const outOfScopeSections = new Set<string>(refusedSections);
	for (const probe of probes) {
		if (!visibleKeys.has(probe.key)) outOfScopeSections.add(probe.section_tipo);
	}
	for (const sectionTipo of outOfScopeSections) {
		noteFrontierRefusal(
			{ principal, surface: 'door', door: SECTION_TERMS_DOOR },
			{ surface: 'door', door: SECTION_TERMS_DOOR, sectionTipo, key: 'record' },
		);
	}
	return keyed.filter((entry) => admittedKeys.has(entry.key));
}
