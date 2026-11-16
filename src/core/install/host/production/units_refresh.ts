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
 * units.ts templateWrites / dropinWrites, instance_record.ts), then
 *
 *   - a template ABSENT or byte-equal                    → written / kept;
 *   - a template of an EARLIER SHIPPED RELEASE (its digest in
 *     deploy/systemd/shipped_digests.json — units.ts templateVerdicts)  → upgraded,
 *     UNLESS another instance on the host does not yet run this release's
 *     drop-ins (units.ts THE SIBLING LAW): then it is KEPT (`deferred`) and the
 *     report names each blocking instance with its REMEDY — its own re-render
 *     command when its tree is this release, an update of that instance first
 *     when it is an earlier one; a sibling record that cannot be read (the
 *     CLI's reader throws on a corrupt file) is a named blocker, never a throw
 *     out of this refresh — the last instance brought here upgrades the template;
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

import type { HostPlanCtx } from '../contract.ts';
import type { HostFs } from '../fs.ts';
import { hostRefuse } from '../refuse.ts';
import { UNIT_TEMPLATES } from '../systemd/render.ts';
import { type RecordReader, recordedPlanContext } from './instance_record.ts';
import {
	deferredTemplateSentence,
	dropinWrites,
	foreignTemplateSentence,
	type SiblingBlocker,
	type TemplateUpgradeDecision,
	templateUpgradeDecision,
	templateWrites,
} from './units.ts';

/** What the refresh reads of the host: the record (readHostRecord — the scratch seam applies) and systemctl. */
export interface UnitsRefreshDeps {
	readonly fs: HostFs;
	/** The record of ANY instance on the host (the siblings are judged through it too). */
	readonly readRecord: RecordReader;
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
	/** Shipped templates KEPT at an earlier render — the sibling law: `blockers` are not ready. */
	readonly deferred: string[];
	/** The other instances that are not on this release's drop-ins yet, each with its re-render command. */
	readonly blockers: SiblingBlocker[];
	/** Drop-ins and the manifest rewritten (always — they are re-rendered from the plan). */
	readonly dropins: string[];
	/** The one-line hint for the operator. */
	readonly next: string;
}

/** Write every template the decision writes; a foreign one refuses first (nothing written); a deferred one is kept. */
function applyTemplates(
	ctx: HostPlanCtx,
	deps: UnitsRefreshDeps,
): Pick<UnitsRefreshReport, 'written' | 'upgraded' | 'kept' | 'deferred' | 'blockers'> & {
	decision: TemplateUpgradeDecision;
} {
	const decision = templateUpgradeDecision(ctx, deps.fs, deps.readRecord);
	if (decision.foreign.length > 0) {
		hostRefuse(
			'install.state_conflict',
			`${foreignTemplateSentence(decision.foreign.map((v) => v.path))}; nothing re-rendered`,
		);
	}
	const report = {
		written: [] as string[],
		upgraded: [] as string[],
		kept: decision.verdicts.filter((v) => v.verdict === 'current').map((v) => v.path),
		deferred: decision.deferred.map((v) => v.path),
		blockers: decision.blockers,
	};
	const writes = templateWrites(ctx);
	for (const verdict of decision.write) {
		const write = writes.find((w) => w.path === verdict.path);
		if (write === undefined) continue;
		deps.fs.write(write.path, write.content, write.mode, write.owner, write.group);
		(verdict.verdict === 'absent' ? report.written : report.upgraded).push(verdict.path);
	}
	return { ...report, decision };
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
	const { written, upgraded, kept, deferred, blockers, decision } = applyTemplates(ctx, deps);
	const dropins = rewriteInstanceFiles(ctx, deps);
	deps.systemctl(['daemon-reload']);
	const deferredNote = deferred.length === 0 ? '' : `; ${deferredTemplateSentence(decision, ctx)}`;
	return {
		instance,
		written,
		upgraded,
		kept,
		deferred,
		blockers,
		dropins,
		next: `the rendered units apply at the next start: systemctl restart dedalo-ts@${instance}.service (${UNIT_TEMPLATES.length} templates: ${written.length} written, ${upgraded.length} upgraded, ${kept.length} current, ${deferred.length} kept at an earlier release; ${dropins.length} instance files re-rendered)${deferredNote}`,
	};
}
