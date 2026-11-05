/**
 * Scratch ontology SOURCE records for the machine-name converter's gates (P3,
 * WC-2026-11-04-ontology-machine-names): raw `matrix_ontology` rows of a `zz*` scratch
 * section, in every shape the kernel (src/core/ontology/machine_name_convert.ts) judges —
 * legacy name nodes, converted nodes, label nodes with and without a stated flag.
 *
 * Raw rows on purpose: the converter must judge the bytes an import or an old install
 * leaves, not what a save door would have normalised. Suite database only
 * (assertTestDatabase before the first write); `sweepMachineNameScratch` removes the
 * rows AND any dd_ontology projection a rebuild made of them.
 */

import { deleteTldNodes } from '../../src/core/db/dd_ontology.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

/** A stored literal item. */
export interface ScratchItem {
	id: number;
	lang: string;
	value: string;
}

/** What one scratch record states (absent keys are not written). */
export interface ScratchRecord {
	sectionId: number;
	/** ontology5 items. */
	term?: ScratchItem[];
	/** ontology43 value (one lg-nolan item). */
	machineName?: string;
	/** ontology44: true = dd64/1, false = dd64/2. */
	flag?: boolean;
	/** ontology6: the model node's tipo (`dd<N>`), as the dd0/N locator. */
	modelTipo?: string;
}

/** The dd model definition whose stored name is `name` (matrix_table, table, …). */
export async function modelTipoNamed(name: string): Promise<string> {
	const rows = (await sql.unsafe(
		`SELECT tipo FROM dd_ontology
		  WHERE tld = 'dd' AND is_model = true AND model_tipo IS NULL
		    AND (machine_name = $1 OR (machine_name IS NULL AND term->>'lg-spa' = $1))
		  ORDER BY id LIMIT 1`,
		[name],
	)) as { tipo: string }[];
	const tipo = rows[0]?.tipo;
	if (tipo === undefined) throw new Error(`machine_name_scratch: no dd model named '${name}'`);
	return tipo;
}

/** A yes/no locator of ontology44. */
function flagLocator(flag: boolean): Record<string, unknown> {
	return {
		type: 'dd151',
		section_id: flag ? '1' : '2',
		section_tipo: 'dd64',
		from_component_tipo: 'ontology44',
	};
}

/** The model locator (`dd<N>` → dd0/N). */
function modelLocator(modelTipo: string): Record<string, unknown> {
	const match = /^([a-z]+)(\d+)$/.exec(modelTipo);
	if (match === null) throw new Error(`machine_name_scratch: bad model tipo '${modelTipo}'`);
	return {
		type: 'dd151',
		section_id: match[2],
		section_tipo: `${match[1]}0`,
		from_component_tipo: 'ontology6',
	};
}

/** The `string` / `relation` columns of one scratch record. */
export function scratchColumns(
	tld: string,
	record: ScratchRecord,
): { string: Record<string, unknown>; relation: Record<string, unknown> } {
	const string: Record<string, unknown> = { ontology7: [{ id: 1, lang: 'lg-nolan', value: tld }] };
	if (record.term !== undefined) string.ontology5 = record.term;
	if (record.machineName !== undefined) {
		string.ontology43 = [{ id: 1, lang: 'lg-nolan', value: record.machineName }];
	}
	const relation: Record<string, unknown> = {};
	if (record.flag !== undefined) relation.ontology44 = [flagLocator(record.flag)];
	if (record.modelTipo !== undefined) relation.ontology6 = [modelLocator(record.modelTipo)];
	return { string, relation };
}

/** Insert the records into `<tld>0` (suite database only). */
export async function seedMachineNameScratch(
	tld: string,
	records: readonly ScratchRecord[],
): Promise<void> {
	await assertTestDatabase('seedMachineNameScratch');
	for (const record of records) {
		const { string, relation } = scratchColumns(tld, record);
		await sql.unsafe(
			`INSERT INTO matrix_ontology (section_id, section_tipo, string, relation)
			 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb)`,
			[record.sectionId, `${tld}0`, JSON.stringify(string), JSON.stringify(relation)],
		);
	}
	await clearOntologyDerivedCaches();
}

/** Delete given records of `<tld>0` by id. */
export async function deleteMachineNameScratch(
	tld: string,
	sectionIds: readonly number[],
): Promise<void> {
	await assertTestDatabase('deleteMachineNameScratch');
	for (const id of sectionIds) {
		await sql.unsafe('DELETE FROM matrix_ontology WHERE section_tipo = $1 AND section_id = $2', [
			`${tld}0`,
			id,
		]);
	}
	await clearOntologyDerivedCaches();
}

/** Every record of `<tld>0` and its projection gone. */
export async function sweepMachineNameScratch(tld: string): Promise<void> {
	await assertTestDatabase('sweepMachineNameScratch');
	await sql.unsafe('DELETE FROM matrix_ontology WHERE section_tipo = $1', [`${tld}0`]);
	await deleteTldNodes(tld);
	await clearOntologyDerivedCaches();
}

/** The stored `string` + `relation` of every record of `<tld>0`, as text (byte-equality probes). */
export async function scratchBytes(tld: string): Promise<string> {
	const rows = (await sql.unsafe(
		`SELECT section_id, string::text AS s, relation::text AS r FROM matrix_ontology
		  WHERE section_tipo = $1 ORDER BY section_id`,
		[`${tld}0`],
	)) as { section_id: number; s: string | null; r: string | null }[];
	return JSON.stringify(rows);
}
