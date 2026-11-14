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
 *   - data_model        that data version's model equals the target's (D-2);
 *   - host_units        on a production systemd instance, whether the host's unit
 *                       templates are this release's render — ALWAYS ok (the run
 *                       runs as the service user and never writes /etc/systemd):
 *                       when they differ it OFFERS the root re-render command in
 *                       its verdict (`offer`, owner ruling C33, 2026-11-13).
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
import { type HostUnitsState, readHostUnitsState } from './host_units.ts';
import { failureSentence, type RunJournal } from './journal.ts';

export interface PredicateVerdict {
	id: string;
	ok: boolean;
	detail: string;
	/** A ROOT command the operator may run — named, never run (an ok verdict with something to do). */
	offer?: string;
}

/** The install facts the predicates read. */
export interface VerifyReads {
	pendingBootMigrations: () => Promise<string[]>;
	recordedHashes: () => Promise<{ version: string; sha256: string | null }[]>;
	ledger: () => Promise<MigrationLedger>;
	installedDataVersion: () => Promise<number[]>;
	hostUnits: () => Promise<HostUnitsState>;
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
	hostUnits: () => readHostUnitsState(),
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

/** The `legacy` sentence: a pre-C32 instance, its templates named when they are not this release's. */
function legacyHostUnitsDetail(state: Extract<HostUnitsState, { kind: 'legacy' }>): string {
	const templates =
		state.templates.length === 0
			? ''
			: `; templates not this release's render: ${state.templates.join(', ')}`;
	return `this instance was installed before the writable-roots release: its drop-in names no manifest and opens no ReadWritePaths= (ProtectSystem=strict would run it read-only at its next restart${templates}) — re-render the units as root, then restart the instance: ${state.refresh}${SIBLING_LAW_CLAUSE}`;
}

/**
 * THE SIBLING LAW, said where the offer is made (host/production/units.ts): on
 * a host with several instances the offered command upgrades a SHARED template
 * only once every instance runs this release's drop-ins — until then it keeps
 * the template and names each instance to bring there first (an update of that
 * instance when its tree is an earlier release, then its own re-render), so the
 * offer stands after every update until the last instance is re-rendered.
 */
const SIBLING_LAW_CLAUSE =
	". On a host with several instances the command upgrades a shared template only once every instance runs this release's drop-ins: until then it keeps the earlier template and names each instance to bring to this release first (update it, then its own re-render) — this offer stands until the last one is re-rendered";

/** One sentence per host-units state (the verdict's `detail`). */
function hostUnitsDetail(state: HostUnitsState): string {
	switch (state.kind) {
		case 'not_systemd':
			return 'not a production systemd instance: no unit templates to compare';
		case 'manifest_unreadable':
			return `the writable-roots manifest ${state.path} ${state.reason}: the templates could not be judged (the next boot refuses on it — re-render the units as root: scripts/ops/host_units_refresh.ts --instance <i>)`;
		case 'legacy':
			return legacyHostUnitsDetail(state);
		case 'current':
			return "the host's systemd unit templates are this release's render";
		case 'differs':
			return `the host's systemd unit templates are not this release's render (${state.templates.join(', ')}): the update ran as the service user and never writes /etc/systemd — re-render them as root, then restart the instance: ${state.refresh}${SIBLING_LAW_CLAUSE}`;
	}
}

/**
 * The host's systemd templates vs this release's render (C33). ALWAYS ok: the
 * run has no privilege to rewrite /etc/systemd and gains none; a difference is
 * an OFFER — the instance's own root re-render command, read from the writable-
 * roots manifest the drop-in names (host_units.ts), or derived from the tree on
 * a pre-C32 instance (`legacy`). Not a systemd instance: nothing to judge, said so.
 */
const hostUnits: Predicate['check'] = async (_journal, reads) => {
	const state = await reads.hostUnits();
	const offered = state.kind === 'legacy' || state.kind === 'differs';
	return {
		ok: true,
		detail: hostUnitsDetail(state),
		...(offered ? { offer: state.refresh } : {}),
	};
};

/** The predicates VERIFIED requires, in report order. */
export const RUN_VERIFY_PREDICATES: readonly Predicate[] = [
	{ id: 'schema_clean', check: schemaClean },
	{ id: 'data_version', check: dataVersion },
	{ id: 'data_model', check: dataModel },
	{ id: 'host_units', check: hostUnits },
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
