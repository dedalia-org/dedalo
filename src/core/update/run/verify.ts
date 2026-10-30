/**
 * POST-VERIFY: what VERIFIED means (update audit 2026-10-29, U-01; design §3.5).
 *
 * A run is confirmed on evidence, never on "the process answered": each
 * predicate below reads the install and says ok or not with a detail an
 * operator can act on. VERIFIED requires every predicate ok; the run records
 * the full list in its journal either way.
 *
 * The predicates of the phases that exist today:
 *   - schema_clean      no boot migration pending (ONLINE ones run post-confirm),
 *                       and every recorded hash equals the frozen ledger's (U-23);
 *   - data_version      the database's data version equals the target's (U-04);
 *   - data_model        that data version's model equals the target's (D-2).
 * Later phases append theirs (ontology census, tool registry, observers,
 * search derivation, media rules — design §3.5) to `RUN_VERIFY_PREDICATES`.
 *
 * Every read is a seam (`VerifyReads`) so a gate drives each verdict without
 * the ambient database.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	MIGRATIONS_DIR,
	MIGRATIONS_VERSION_TABLE,
	pendingMigrations,
} from '../../../../install/db/migrate.ts';
import {
	type MigrationLedger,
	readMigrationLedger,
} from '../../../../install/db/migration_ledger.ts';
import { isOnlineMigration } from '../../../../install/db/online_migration.ts';
import { readInstalledDataVersionStrict } from '../../area_maintenance/backup.ts';
import { sql } from '../../db/postgres.ts';
import { formatVersion } from '../version.ts';
import { dataModelOf } from '../version_contract.ts';
import { failureSentence, type RunJournal } from './journal.ts';

export interface PredicateVerdict {
	id: string;
	ok: boolean;
	detail: string;
}

/** The install facts the predicates read. */
export interface VerifyReads {
	pendingBootMigrations: () => Promise<string[]>;
	recordedHashes: () => Promise<{ version: string; sha256: string | null }[]>;
	ledger: () => Promise<MigrationLedger>;
	installedDataVersion: () => Promise<number[]>;
}

/** The pending files the BOOT runner owns (ONLINE files are post-confirm). */
async function pendingBootMigrations(): Promise<string[]> {
	const { pending } = await pendingMigrations();
	const boot: string[] = [];
	for (const file of pending) {
		if (!isOnlineMigration(await readFile(join(MIGRATIONS_DIR, file), 'utf8'))) boot.push(file);
	}
	return boot;
}

export const PRODUCTION_VERIFY_READS: VerifyReads = {
	pendingBootMigrations,
	recordedHashes: async () =>
		(await sql.unsafe(`SELECT version, sha256 FROM "${MIGRATIONS_VERSION_TABLE}"`, [])) as {
			version: string;
			sha256: string | null;
		}[],
	ledger: () => readMigrationLedger(),
	installedDataVersion: readInstalledDataVersionStrict,
};

/** One named check: its verdict's `ok` and `detail` (the id is the predicate's). */
interface Predicate {
	id: string;
	check: (journal: RunJournal, reads: VerifyReads) => Promise<Omit<PredicateVerdict, 'id'>>;
}

const schemaClean: Predicate['check'] = async (_journal, reads) => {
	const pending = await reads.pendingBootMigrations();
	const ledger = await reads.ledger();
	const drifted = (await reads.recordedHashes())
		.filter((row) => row.sha256 !== null && ledger.migrations[row.version]?.sha256 !== row.sha256)
		.map((row) => row.version);
	const problems = [
		...(pending.length > 0 ? [`pending: ${pending.join(', ')}`] : []),
		...(drifted.length > 0 ? [`hash differs from the ledger: ${drifted.join(', ')}`] : []),
	];
	return {
		ok: problems.length === 0,
		detail:
			problems.length === 0 ? 'every boot migration applied, hashes = ledger' : problems.join('; '),
	};
};

const dataVersion: Predicate['check'] = async (journal, reads) => {
	const installed = formatVersion(await reads.installedDataVersion());
	return {
		ok: installed === journal.to.data,
		detail: `database ${installed}, target ${journal.to.data}`,
	};
};

const dataModel: Predicate['check'] = async (journal, reads) => {
	const model = dataModelOf(await reads.installedDataVersion());
	const named = model === null ? 'unknown' : formatVersion(model);
	return {
		ok: named === journal.to.model,
		detail: `database on model ${named}, target model ${journal.to.model}`,
	};
};

/** The predicates VERIFIED requires, in report order. */
export const RUN_VERIFY_PREDICATES: readonly Predicate[] = [
	{ id: 'schema_clean', check: schemaClean },
	{ id: 'data_version', check: dataVersion },
	{ id: 'data_model', check: dataModel },
];

/** A predicate whose read threw is RED, its sentence pointing at the log. */
function unreadable(id: string, thrown: unknown): Omit<PredicateVerdict, 'id'> {
	const detail = failureSentence(`post-verify ${id} could not be read`, thrown);
	return { ok: false, detail };
}

/**
 * Run every predicate (a predicate that throws is a failed one, its error the
 * detail — never a skipped one). VERIFIED iff all are ok.
 */
export async function verifyRun(
	journal: RunJournal,
	reads: VerifyReads = PRODUCTION_VERIFY_READS,
	predicates: readonly Predicate[] = RUN_VERIFY_PREDICATES,
): Promise<{ verified: boolean; verdicts: PredicateVerdict[] }> {
	const verdicts: PredicateVerdict[] = [];
	for (const { id, check } of predicates) {
		const verdict = await check(journal, reads).catch((thrown: unknown) => unreadable(id, thrown));
		verdicts.push({ id, ...verdict });
	}
	return { verified: verdicts.every((verdict) => verdict.ok), verdicts };
}
