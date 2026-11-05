/**
 * ============================================================================
 * RECONCILE — the ONE CLI door onto the reconcile registry
 * (src/core/reconcile/registry.ts, audit 2026-08-26 S-10).
 * ============================================================================
 *
 * Every cross-store reconcile the engine ships is a registered definition:
 * what it compares, how it is scheduled, and a run that REPORTS drift without
 * writing (the default) or REPAIRS it (--apply). This shell lists them and
 * runs one; the maintenance widget `reconcile_status` is the same door in the
 * browser, the `reconcile` gauge on /api/v1/counters the same verdicts from a
 * live server. The per-subsystem shells (scripts/observer_reconcile.ts,
 * scripts/media_repair_files_info.ts, rag_drain --reconcile) keep their
 * narrower flags and wrap the same definitions.
 *
 * USAGE:
 *
 *     bun scripts/reconcile.ts list [--json]
 *     bun scripts/reconcile.ts run <name> [--apply] [--scope a,b] [--json]
 *
 * Exit status: 0 = in sync (drift 0, or applied everything it found);
 * 2 = drift reported and NOT repaired (dry run, or held units); 1 = usage /
 * the run threw.
 */

// Side-effect: registers the component-model lookup the ontology resolver
// requires (standalone scripts must do what the server entrypoint does).
import '../src/core/components/registry.ts';
import { registerAllReconciles } from '../src/core/reconcile/catalog.ts';
import { runReconcile } from '../src/core/reconcile/registry.ts';

function usage(message?: string): never {
	if (message !== undefined) console.error(`error: ${message}\n`);
	console.error(
		[
			'usage:',
			'  bun scripts/reconcile.ts list [--json]',
			'  bun scripts/reconcile.ts run <name> [--apply] [--scope a,b] [--json]',
		].join('\n'),
	);
	process.exit(1);
}

function scheduleText(schedule: unknown): string {
	if (typeof schedule === 'object' && schedule !== null && 'everyMs' in schedule) {
		const { everyMs, atBoot } = schedule as { everyMs: number; atBoot?: boolean };
		const every = `every ${Math.round(Number(everyMs) / 60000)} min`;
		return atBoot === true ? `boot + ${every}` : every;
	}
	return String(schedule);
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const command = argv[0];
	const json = argv.includes('--json');
	const definitions = await registerAllReconciles();

	if (command === 'list') {
		if (json) {
			console.log(
				JSON.stringify(
					definitions.map((d) => ({
						name: d.name,
						stores: d.stores,
						description: d.description,
						scope_label: d.scopeLabel,
						schedule: d.schedule,
						auto_apply: d.autoApply?.reason ?? null,
					})),
					null,
					2,
				),
			);
			return 0;
		}
		for (const d of definitions) {
			console.log(
				`${d.name.padEnd(18)} ${scheduleText(d.schedule).padEnd(10)}${d.autoApply ? '(auto-apply) ' : ''}${d.stores[0]}  <->  ${d.stores[1]}`,
			);
			console.log(`${''.padEnd(18)} ${d.description}`);
			if (d.scopeLabel !== null) console.log(`${''.padEnd(18)} --scope: ${d.scopeLabel}`);
		}
		return 0;
	}

	if (command !== 'run') usage(command === undefined ? undefined : `unknown command '${command}'`);
	const name = argv[1];
	if (name === undefined || name.startsWith('--')) usage('run needs a reconcile name');
	if (definitions.every((d) => d.name !== name)) {
		usage(`unknown reconcile '${name}' (known: ${definitions.map((d) => d.name).join(', ')})`);
	}
	const apply = argv.includes('--apply');
	const scopeAt = argv.indexOf('--scope');
	const scopeRaw = scopeAt === -1 ? undefined : argv[scopeAt + 1];
	if (scopeAt !== -1 && (scopeRaw === undefined || scopeRaw.startsWith('--')))
		usage('--scope needs a value');
	const scope = scopeRaw
		?.split(',')
		.map((s) => s.trim())
		.filter((s) => s !== '');

	const { report, record } = await runReconcile(name, {
		apply,
		...(scope === undefined ? {} : { scope }),
	});
	if (json) {
		console.log(JSON.stringify({ record, report }, null, 2));
	} else {
		console.log(
			`${name}: ${apply ? 'APPLY' : 'DRY-RUN'} — drift ${report.drift}, applied ${report.applied} (${record.durationMs} ms)`,
		);
		console.log(JSON.stringify(report.detail, null, 2));
		if (report.deferred !== undefined)
			console.log(`\nDEFERRED: ${report.deferred.reason} — nothing applied. Re-run it.`);
		if (report.refused !== undefined)
			console.log(`\nREFUSED: ${report.refused.reason} — nothing applied.`);
		if (!apply && report.drift > 0)
			console.log('\nDry run: nothing written. Re-run with --apply to repair.');
	}
	return report.drift === 0 || report.applied >= report.drift ? 0 : 2;
}

let status: number;
try {
	status = await main();
} catch (error) {
	console.error(error);
	status = 1;
}
process.exit(status);
