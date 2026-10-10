/**
 * `<tld>0` root node hangs under its REGISTRY typology, not a blind 'others'.
 * TS-native write-path contract.
 *
 * THE BUG THIS CLOSES. The ontology-update door called `createDdOntologyRootNode`
 * with only `{tld, section_tipo}`; the function then defaulted typology to 15
 * ('others') and the term to the bare tld. Every TLD an update re-provisioned
 * (`dd`, `tch`, …) was re-hung under `ontologytype15` with term `dd` — so the
 * security-access tree (dd774) listed `dd0` under Others although its
 * `ontology35` registry record says Core (14), "Dédalo | dd".
 *
 * Contract: an absent `typology_id` / `name_data` is read from the TLD's
 * `ontology35` registry record (PHP get_typology_locator_from_tld), 15 only
 * when that record carries none.
 *
 * Scratch: tld 'zzrn' (registry row + `zzrn0` dd_ontology row), swept.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import {
	createDdOntologyRootNode,
	createMainSection,
} from '../../src/core/ontology/ontology_write.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const TLD = 'zzrn';
const CORE_TYPOLOGY = 14;
const NAME = 'Root node probe | zzrn';

async function sweep(): Promise<void> {
	await sql`DELETE FROM dd_ontology WHERE tipo = ${`${TLD}0`}`;
	const mains = (await sql`SELECT section_id FROM matrix_ontology_main
	                         WHERE string->'hierarchy6' @> ${JSON.stringify([{ value: TLD }])}::text::jsonb`) as {
		section_id: number;
	}[];
	for (const { section_id } of mains) {
		await sql`DELETE FROM matrix_time_machine
		          WHERE section_tipo = 'ontology35' AND section_id = ${section_id}`;
		await sql`DELETE FROM matrix_ontology_main
		          WHERE section_tipo = 'ontology35' AND section_id = ${section_id}`;
	}
	await clearOntologyDerivedCaches();
}

beforeAll(async () => {
	await assertTestDatabase('ontology_root_node_typology_native');
	await sweep();
});

afterAll(sweep);

describe('createDdOntologyRootNode without typology/name', () => {
	test('reads them from the registry record: Core parent, registry term', async () => {
		await createMainSection({
			tld: TLD,
			typology_id: CORE_TYPOLOGY,
			name_data: [{ lang: 'lg-eng', value: NAME }],
		});
		// The ontology-update door's shape before the fix: tld only.
		await createDdOntologyRootNode({ tld: TLD });

		const rows = (await sql`SELECT parent, term FROM dd_ontology WHERE tipo = ${`${TLD}0`}`) as {
			parent: string;
			term: Record<string, string>;
		}[];
		expect(rows.length).toBe(1);
		expect(rows[0]?.parent).toBe(`ontologytype${CORE_TYPOLOGY}`);
		expect(rows[0]?.term['lg-eng']).toBe(NAME);
	});
});
