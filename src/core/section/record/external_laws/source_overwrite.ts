/**
 * SUB-LAW (b) — SOURCE OVERWRITE (PHP set_data_external "tool cataloging
 * case", frozen class.component_relation_common.php:1849-1888): the mirror is
 * a COPY of another record's component. The pointer component of the target
 * record (`source.component_to_search`) names that record; the copied
 * component is `source.source_overwrite.data_from_field`.
 *
 * The live case is tool_cataloging: a catalog term's numisdata656 points at a
 * type, and the term's numisdata679 / numisdata965 copy that type's
 * numisdata77 (its coins) / numisdata11 (its ordered coins). The suite twin is
 * testcoincatalog1004 → testcoincatalog1013 (test6157) / testcoincatalog1019
 * (test6105).
 *
 * THE LAW, inside the kernel's transaction:
 *   1. ONE read of the target row — the mirror, its `_hi` index AND the
 *      pointer — FOR UPDATE: the pointer is adjudicated under the same lock
 *      as the bag it decides.
 *   2. The FIRST pointer locator, in stored order, whose section DECLARES
 *      `dataFromField` (the one section census, declaredSectionComponents —
 *      virtual-aware: a term stored under a virtual section, a type under
 *      its real one). PHP took the first locator BLINDLY, so a term whose
 *      first link was a mint or a period copied nothing (WC-ledgered).
 *   3. The source row's `relation->dataFromField`, FOR SHARE. LOCK ORDER is
 *      always target, then source; a source writer reaches the target only
 *      after its own COMMIT (the obligation ledger), so the two cannot
 *      deadlock, and whichever commits last converges.
 *   4. Outcomes:
 *        - the source bag                → desired, order 'desired' (the
 *          order is the value: "ordered coins"), no freeze (PHP had none on
 *          this path);
 *        - empty pointer / no qualifying → [] (PHP left the mirror stale —
 *          an unlinked term kept the old type's coins forever; WC-ledgered);
 *        - the pointed record is GONE    → [] (owner ruling 2026-10-30, PHP
 *          parity: get_data on a missing record is empty);
 *        - `dataFromField` has NO ontology node, or the pointed section has
 *          no matrix table               → a DEFECT: the law is unanswerable,
 *          so the kernel withholds every drop.
 *
 * DEPENDENCY (U3 pass 3, owner ruling Q1): the mirror reads
 * `dataFromField` on a FOREIGN record, so a save of it must reach the
 * observer — the derived edge `{observed: dataFromField, via: pointer}`. A
 * law that reads D without depending on D is stale by construction
 * (numisdata679 ← numisdata77 had no declared edge).
 */

import { incrementCounter } from '../../../api/counters.ts';
import { canonicalizeStoredSectionId } from '../../../concepts/section_id.ts';
import { sql } from '../../../db/postgres.ts';
import { getMatrixTableFromTipo, getNode } from '../../../ontology/resolver.ts';
import type {
	CandidateScope,
	DesiredLocator,
	ExternalValueLaw,
	LawComputeContext,
	LawComputeResult,
	LawDependency,
	SourceOverwriteLaw,
	StoredLocator,
} from './types.ts';

/** A stored bag value as an array of objects (anything else reads as empty). */
function bagOf(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? (value.filter((item) => item !== null && typeof item === 'object') as Record<
				string,
				unknown
			>[])
		: [];
}

/** The record the pointer names, as an integer address — or why it cannot be one. */
function pointerAddress(
	locator: unknown,
): { section_tipo: string; section_id: number } | { malformed: string } {
	const raw = locator as { section_tipo?: unknown; section_id?: unknown } | null;
	if (raw === null || typeof raw !== 'object' || typeof raw.section_tipo !== 'string') {
		return { malformed: 'no section_tipo' };
	}
	const sectionId = canonicalizeStoredSectionId(raw.section_id);
	if (typeof sectionId !== 'number' || !Number.isInteger(sectionId)) {
		return { malformed: `section_id ${JSON.stringify(raw.section_id)} is not a record address` };
	}
	return { section_tipo: raw.section_tipo, section_id: sectionId };
}

/**
 * The first pointer locator whose section declares `dataFromField` (step 2).
 * A malformed locator is skipped LOUDLY (counted): it cannot address a row,
 * and a later well-formed one may still qualify.
 */
async function firstQualifyingPointer(
	law: SourceOverwriteLaw,
	pointer: unknown,
	where: string,
): Promise<{ section_tipo: string; section_id: number } | undefined> {
	const { sectionDeclaresComponent } = await import('./resolvers.ts');
	for (const locator of bagOf(pointer)) {
		const address = pointerAddress(locator);
		if ('malformed' in address) {
			console.error(
				`observer '${law.observerTipo}' @ ${where}: pointer '${law.pointerTipo}' locator skipped (${address.malformed}):`,
				locator,
			);
			incrementCounter('observers_source_overwrite_pointer_malformed');
			continue;
		}
		if (await sectionDeclaresComponent(address.section_tipo, law.dataFromField)) return address;
	}
	return undefined;
}

/** Step 1: bag + index + pointer, one row, one lock. */
async function readSourceOverwriteRow(
	law: SourceOverwriteLaw,
	context: LawComputeContext,
): Promise<{ bag: StoredLocator[] | null; pointer: unknown; idx: unknown } | undefined> {
	const { targetSection, targetId, table, lock } = context;
	const rows = (await sql.unsafe(
		`SELECT relation->$3 AS bag, relation->$4 AS pointer, relation_search->$3 AS idx FROM "${table}" WHERE section_tipo = $1 AND section_id = $2${lock ? ' FOR UPDATE' : ''}`,
		[targetSection, targetId, law.observerTipo, law.pointerTipo],
	)) as { bag: StoredLocator[] | null; pointer: unknown; idx: unknown }[];
	return rows[0];
}

/**
 * Step 3: the pointed record's `dataFromField` bag under FOR SHARE (the target
 * is already locked — the order). A pointed record that is gone copies nothing
 * (PHP parity, owner ruling Q3); a pointed section without a matrix table is an
 * unanswerable copy (a defect: drops withheld).
 */
async function copyPointedBag(
	law: SourceOverwriteLaw,
	source: { section_tipo: string; section_id: number },
	lock: boolean,
	where: string,
): Promise<{ desired: DesiredLocator[]; defects: string[] }> {
	const sourceTable = await getMatrixTableFromTipo(source.section_tipo);
	if (sourceTable === null) {
		console.error(
			`observer '${law.observerTipo}' @ ${where}: pointed section '${source.section_tipo}' has no matrix table — the copy is unanswerable, drops withheld`,
		);
		incrementCounter('observers_source_overwrite_table_unresolved');
		return { desired: [], defects: [`source_table_unresolved:${source.section_tipo}`] };
	}
	const sourceRows = (await sql.unsafe(
		`SELECT relation->$3 AS bag FROM "${sourceTable}" WHERE section_tipo = $1 AND section_id = $2${lock ? ' FOR SHARE' : ''}`,
		[source.section_tipo, source.section_id, law.dataFromField],
	)) as { bag: unknown }[];
	return { desired: bagOf(sourceRows[0]?.bag) as DesiredLocator[], defects: [] };
}

async function computeSourceOverwrite(
	law: SourceOverwriteLaw,
	context: LawComputeContext,
): Promise<LawComputeResult> {
	const { targetSection, targetId, lock } = context;
	const where = `${targetSection}/${targetId}`;
	const { getRelationTypeByTipo } = await import('../../../relations/save.ts');
	const base = {
		order: 'desired' as const,
		fallbackType: await getRelationTypeByTipo(law.observerTipo),
		dropSelf: true,
		freeze: false,
	};
	const row = await readSourceOverwriteRow(law, context);
	if (row === undefined) {
		return {
			...base,
			exists: false,
			existing: [],
			storedIndex: null,
			desired: [],
			referenceCount: 0,
			defects: [],
		};
	}
	const answer = (desired: DesiredLocator[], defects: string[] = []): LawComputeResult => ({
		...base,
		exists: true,
		existing: row.bag ?? [],
		storedIndex: row.idx ?? null,
		desired,
		referenceCount: desired.length,
		defects,
	});
	if ((await getNode(law.dataFromField)) === null) {
		console.error(
			`observer '${law.observerTipo}' @ ${where}: source_overwrite.data_from_field '${law.dataFromField}' has NO ontology node — the copy is unanswerable, drops withheld`,
		);
		incrementCounter('observers_source_overwrite_node_missing');
		return answer([], [`data_from_field_node_missing:${law.dataFromField}`]);
	}
	// Step 2: the first qualifying pointer locator; none = nothing to copy.
	const source = await firstQualifyingPointer(law, row.pointer, where);
	if (source === undefined) return answer([]);
	const copy = await copyPointedBag(law, source, lock, where);
	return answer(copy.desired, copy.defects);
}

/**
 * The reconciler's candidates at one host section: the records that already
 * hold the mirror ∪ the records whose pointer is non-empty. A section that
 * does not declare the observer holds no candidate (the host predicate).
 */
async function sourceOverwriteCandidateIds(
	law: SourceOverwriteLaw,
	scope: CandidateScope,
	hostTable: string,
	onlyId: number | null,
): Promise<number[]> {
	const { isObserverHostSection } = await import('./resolvers.ts');
	if (!(await isObserverHostSection(scope.observerTipo, scope.hostSection))) return [];
	const pointing = (await sql.unsafe(
		`SELECT DISTINCT section_id AS id FROM matrix_relation_index
		 WHERE section_tipo = $1 AND from_component_tipo = $2`,
		[scope.hostSection, law.pointerTipo],
	)) as { id: number }[];
	const holders = (await sql.unsafe(
		`SELECT section_id AS id FROM "${hostTable}" WHERE section_tipo = $1 AND relation ? $2`,
		[scope.hostSection, scope.observerTipo],
	)) as { id: number }[];
	const ids = new Set<number>();
	for (const row of [...pointing, ...holders]) ids.add(Number(row.id));
	if (onlyId !== null) return ids.has(onlyId) ? [onlyId] : [];
	return [...ids].sort((a, b) => a - b);
}

/** The derived dependency edge (see the header). */
function sourceOverwriteDependencies(law: SourceOverwriteLaw): readonly LawDependency[] {
	return [{ observed: law.dataFromField, resolver: 'inverse', via: law.pointerTipo }];
}

export const sourceOverwriteLaw: ExternalValueLaw<SourceOverwriteLaw> = Object.freeze({
	kind: 'source_overwrite' as const,
	compute: computeSourceOverwrite,
	dependencies: sourceOverwriteDependencies,
	pointer: (law: SourceOverwriteLaw) => law.pointerTipo,
	candidateIds: sourceOverwriteCandidateIds,
});
