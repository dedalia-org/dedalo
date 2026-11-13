/**
 * RE-RENDER AN INSTANCE'S UNITS FROM ITS FROZEN PLAN (owner rulings C32 / C33,
 * 2026-11-13) — THE ROOT COMMAND the writable-roots manifest, the engine's boot
 * refusal and the update run's post-verify offer all name:
 *
 *   sudo /opt/dedalo/bun/<pin>/bun run <tree>/scripts/ops/host_units_refresh.ts --instance <i>
 *
 * What it does, from the record host_units wrote (/var/lib/dedalo-install/<i>/:
 * the plan's answers, the preflight's frozen facts) and the host registry's bun
 * pin: renders this release's templates and the instance's drop-ins + the
 * writable-roots manifest EXACTLY as host_units would (one derivation —
 * units.ts templateWrites / dropinWrites), then
 *
 *   - a template ABSENT or byte-equal                    → written / kept;
 *   - a template of an EARLIER SHIPPED RELEASE (its digest in
 *     deploy/systemd/shipped_digests.json — units.ts templateVerdicts)  → upgraded;
 *   - a FOREIGN template (another installer's, a hand edit) → the whole refresh
 *     REFUSED, nothing written (units.ts: the installer never overwrites it);
 *   - the drop-ins and the manifest                        → rewritten (they are
 *     this instance's own — the operator's answers, re-rendered);
 *   - `systemctl daemon-reload`; the instance is NOT restarted (the operator
 *     chooses the moment: the new unit applies at the next restart).
 *
 * Why not `--resume`: a complete install has nothing pending, and host_units is a
 * step of a RUN; this is a repair of the units ALONE, with no run record touched.
 * Why a root command and not an update step: the update runs as the service
 * user (code_update.ts) and /etc/systemd is root's — the run only OFFERS this
 * command (run/verify.ts host_units). PURE but for its seams: `fs` (a HostFs —
 * the scratch root in a gate), `run` (systemctl), `source` (the tree whose
 * templates are rendered).
 */

import { normalizeInstallAnswers } from '../../install_plan.ts';
import type { PlanFile } from '../../run_files_core.ts';
import type { HostPlanCtx } from '../contract.ts';
import type { HostFs } from '../fs.ts';
import { pathsFor } from '../layout.ts';
import { OS_ROWS, type OsRowId, osRowById } from '../os_support.ts';
import { hostRefuse } from '../refuse.ts';
import { ownEntry } from '../registry.ts';
import { bunPinOf, sourceTreeRoot } from '../source.ts';
import { UNIT_TEMPLATES } from '../systemd/render.ts';
import {
	dropinWrites,
	foreignTemplateSentence,
	templateVerdicts,
	templateWrites,
} from './units.ts';

/** What the refresh reads of the host: the record (readHostRecord — the scratch seam applies) and systemctl. */
export interface UnitsRefreshDeps {
	readonly fs: HostFs;
	readonly readRecord: (instance: string) => {
		plan: PlanFile;
		state: { preflight: { host?: { facts: HostPlanCtx['facts'] } } } | null;
	} | null;
	/** Run `systemctl <args>`; throws on a non-zero exit. */
	readonly systemctl: (args: readonly string[]) => void;
	readonly source?: string;
}

export interface UnitsRefreshReport {
	readonly instance: string;
	/** Templates written (absent before). */
	readonly written: string[];
	/** Templates upgraded in place (an earlier shipped render). */
	readonly upgraded: string[];
	/** Templates already this release's render. */
	readonly kept: string[];
	/** Drop-ins and the manifest rewritten (always — they are re-rendered from the plan). */
	readonly dropins: string[];
	/** The one-line hint for the operator. */
	readonly next: string;
}

/** The recorded plan and its measured host facts, or the refusal that names what is missing. */
function recordedPlanAndFacts(
	instance: string,
	readRecord: UnitsRefreshDeps['readRecord'],
): { plan: PlanFile; facts: HostPlanCtx['facts']; os: OsRowId } {
	const record = readRecord(instance);
	if (record === null) {
		hostRefuse(
			'install.state_conflict',
			`no production install record for instance '${instance}' (/var/lib/dedalo-install/${instance}/) — the units can be rendered only from the plan the installer wrote`,
		);
	}
	const facts = record.state?.preflight.host?.facts;
	if (facts === undefined || facts.os === null) {
		hostRefuse(
			'install.state_conflict',
			`the install record of '${instance}' holds no measured host facts (the System check never ran to completion) — finish or abort the install first`,
		);
	}
	return { plan: record.plan, facts, os: facts.os };
}

/** The plan context of a recorded instance — the executor's own derivation (host_executor.ts planContext). */
export function recordedPlanContext(
	instance: string,
	deps: Pick<UnitsRefreshDeps, 'fs' | 'readRecord' | 'source'>,
): HostPlanCtx {
	const source = deps.source ?? sourceTreeRoot();
	const { plan, facts, os } = recordedPlanAndFacts(instance, deps.readRecord);
	const answers = normalizeInstallAnswers(plan.answers as Record<string, unknown>).answers;
	// The runtime pin the instance RUNS (the registry) — not necessarily this tree's.
	const treePin = bunPinOf(source);
	const pin = ownEntry(deps.fs, pathsFor(answers, treePin, facts))?.bun_pin ?? treePin;
	return {
		plan,
		answers,
		facts,
		row: osRowById(os) ?? (OS_ROWS[0] as (typeof OS_ROWS)[number]),
		paths: pathsFor(answers, pin, facts),
		source,
	};
}

/** Write every template that is not this release's render; a foreign one refuses first (nothing written). */
function applyTemplates(
	ctx: HostPlanCtx,
	deps: UnitsRefreshDeps,
): Pick<UnitsRefreshReport, 'written' | 'upgraded' | 'kept'> {
	const verdicts = templateVerdicts(ctx, deps.fs);
	const foreign = verdicts.filter((v) => v.verdict === 'foreign');
	if (foreign.length > 0) {
		hostRefuse(
			'install.state_conflict',
			`${foreignTemplateSentence(foreign.map((v) => v.path))}; nothing re-rendered`,
		);
	}
	const report = { written: [] as string[], upgraded: [] as string[], kept: [] as string[] };
	const writes = templateWrites(ctx);
	for (const verdict of verdicts) {
		const write = writes.find((w) => w.path === verdict.path);
		if (write === undefined || verdict.verdict === 'current') {
			report.kept.push(verdict.path);
			continue;
		}
		deps.fs.write(write.path, write.content, write.mode, write.owner, write.group);
		(verdict.verdict === 'absent' ? report.written : report.upgraded).push(verdict.path);
	}
	return report;
}

/** Rewrite the instance's own files (the drop-ins and the writable-roots manifest) from the plan. */
function rewriteInstanceFiles(ctx: HostPlanCtx, deps: UnitsRefreshDeps): string[] {
	const dropins: string[] = [];
	for (const write of dropinWrites(ctx)) {
		deps.fs.mkdir(write.path.slice(0, write.path.lastIndexOf('/')), 0o755, 'root', 'root');
		deps.fs.write(write.path, write.content, write.mode, write.owner, write.group);
		dropins.push(write.path);
	}
	return dropins;
}

/** Re-render the instance's units (see the header). Refuses before writing anything. */
export function refreshInstanceUnits(instance: string, deps: UnitsRefreshDeps): UnitsRefreshReport {
	if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(instance)) {
		hostRefuse('install.state_conflict', `'${instance}' is not an instance name`);
	}
	const ctx = recordedPlanContext(instance, deps);
	const { written, upgraded, kept } = applyTemplates(ctx, deps);
	const dropins = rewriteInstanceFiles(ctx, deps);
	deps.systemctl(['daemon-reload']);
	return {
		instance,
		written,
		upgraded,
		kept,
		dropins,
		next: `the rendered units apply at the next start: systemctl restart dedalo-ts@${instance}.service (${UNIT_TEMPLATES.length} templates: ${written.length} written, ${upgraded.length} upgraded, ${kept.length} current; ${dropins.length} instance files re-rendered)`,
	};
}
