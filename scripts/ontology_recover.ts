/**
 * ============================================================================
 * ONTOLOGY RECOVER — the offline repair of a damaged dd_ontology
 * (src/core/ontology/ontology_recover.ts; replaces PHP's recovery mode,
 * WC-2026-11-12-recovery-mode-retired).
 * ============================================================================
 *
 * Runs with the ENGINE STOPPED (an apply refuses while any client holds the
 * database). Dry run unless --apply.
 *
 * USAGE:
 *
 *     bun scripts/ontology_recover.ts [--snapshot [--file <path>]] [--rebuild] [--apply]
 *                                     [--maintenance-db <name>] [--json]
 *
 *   --snapshot   swap the recovery file's core-tld slice (dd, rsc, lg, hierarchy,
 *                ontology, ontologytype, test) into dd_ontology — for a projection
 *                too broken for the parser to re-derive
 *   --file       the recovery file (default: the configured recovery slot)
 *   --rebuild    re-derive every tld's dd_ontology from its source records
 *   (neither)    both, snapshot first
 *
 * Exit status: 0 = applied, or a dry run that found no drift; 2 = dry run that
 * found drift or no recovery file, or an apply that left some unrepaired;
 * 1 = refused or failed.
 */

// Side-effect: registers the component-model lookup the ontology parser
// requires (standalone scripts must do what the server entrypoint does).
import '../src/core/components/registry.ts';
import { DedaloError } from '../src/core/errors/dedalo_error.ts';
import { runOntologyRecover } from '../src/core/ontology/ontology_recover.ts';
import { type OntologyState, ontologyDriftUnits } from '../src/core/ontology/ontology_state.ts';

function usage(message?: string): never {
	if (message !== undefined) console.error(`error: ${message}\n`);
	console.error(
		'usage: bun scripts/ontology_recover.ts [--snapshot [--file <path>]] [--rebuild] [--apply] [--maintenance-db <name>] [--json]',
	);
	process.exit(1);
}

const VALUE_FLAGS = new Set(['--file', '--maintenance-db']);
const SWITCHES = new Set(['--snapshot', '--rebuild', '--apply', '--json']);

function parseArguments(argv: string[]): { values: Map<string, string>; switches: Set<string> } {
	const values = new Map<string, string>();
	const switches = new Set<string>();
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] as string;
		if (VALUE_FLAGS.has(token)) {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith('--')) usage(`${token} needs a value`);
			values.set(token, value);
			i += 1;
		} else if (SWITCHES.has(token)) {
			switches.add(token);
		} else {
			usage(`unknown argument ${token}`);
		}
	}
	return { values, switches };
}

async function main(): Promise<number> {
	const { values, switches } = parseArguments(process.argv.slice(2));
	const both = !switches.has('--snapshot') && !switches.has('--rebuild');
	const snapshotFile = values.get('--file');
	const maintenanceDatabase = values.get('--maintenance-db');
	const report = await runOntologyRecover({
		snapshot: both || switches.has('--snapshot'),
		rebuild: both || switches.has('--rebuild'),
		apply: switches.has('--apply'),
		...(snapshotFile === undefined ? {} : { snapshotFile }),
		...(maintenanceDatabase === undefined ? {} : { maintenanceDatabase }),
	});
	const unrepaired = report.rebuild === null ? 0 : report.rebuild.drift - report.rebuild.applied;

	if (switches.has('--json')) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		const mode = report.apply ? 'APPLY' : 'DRY-RUN';
		if (report.snapshot !== null) {
			const s = report.snapshot;
			if (!s.exists) {
				console.log(
					`${mode} snapshot: NO recovery file at ${s.file} — an apply of this phase refuses`,
				);
			} else {
				console.log(`${mode} snapshot: ${s.file} (${s.bytes} bytes, ${s.modified})`);
				console.log(
					s.swapped === null
						? '  would replace dd_ontology rows of the tlds it holds'
						: `  replaced tlds ${s.swapped.tlds.join(', ')} — ${s.swapped.rows} rows`,
				);
			}
		}
		if (report.rebuild !== null) {
			console.log(
				`${mode} rebuild: drift ${report.rebuild.drift}, applied ${report.rebuild.applied}`,
			);
			// drift units, not `inSync`: a registered-but-never-activated hierarchy is not in sync and not drift
			const states = (report.rebuild.detail.states ?? {}) as Record<string, OntologyState>;
			const drifted = Object.entries(states)
				.filter(([, state]) => ontologyDriftUnits(state) > 0)
				.map(([tld, state]) => `${tld} (${ontologyDriftUnits(state)})`);
			// `states` are read BEFORE the repair: an apply names what it repaired, and what it could not
			if (drifted.length > 0)
				console.log(`  ${report.apply ? 'repaired' : 'drifted'} tlds: ${drifted.join(', ')}`);
			const rebuilt = (report.rebuild.detail.rebuilt ?? {}) as Record<string, { ok?: boolean }>;
			const failed = Object.entries(rebuilt)
				.filter(([, outcome]) => outcome.ok === false)
				.map(([tld]) => tld);
			if (failed.length > 0) console.log(`  NOT repaired: ${failed.join(', ')}`);
		}
		if (report.rebuild_error !== null)
			console.log(
				`${mode} rebuild: the current projection cannot be inspected (${report.rebuild_error}, logged above) — the snapshot step restores the core it needs`,
			);
		if (!report.apply) console.log('nothing written — re-run with --apply');
	}
	// a snapshot asked for with no recovery file is something left to do, like drift
	const snapshotMissing = report.snapshot !== null && !report.snapshot.exists;
	return unrepaired > 0 || snapshotMissing || report.rebuild_error !== null ? 2 : 0;
}

let status: number;
try {
	status = await main();
} catch (error) {
	if (error instanceof DedaloError) {
		console.error(`${error.code}: ${error.message}`);
	} else {
		console.error(error);
	}
	status = 1;
}
process.exit(status);
